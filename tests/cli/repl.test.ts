import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleReplLine, isNewlineKey, resolveAutoApprove } from '../../src/cli/repl.ts';
import type { SkillInfo } from '../../src/core/skills/types.ts';
import type { SessionMeta } from '../../src/core/session-store.ts';
import type { CoreEvent } from '../../src/core/events.ts';

class FakeEngine {
  calls: string[] = [];
  sessions: SessionMeta[] = [];
  failResume = false;
  skills: SkillInfo[] = [{ name: 'review', description: 'Review code', body: 'Body', userInvocable: true }];
  async run(prompt: string): Promise<string> {
    this.calls.push(`run:${prompt}`);
    return 'done';
  }
  async loadSkill(name: string): Promise<SkillInfo> {
    this.calls.push(`load:${name}`);
    return { name, description: 'x', body: 'Body', userInvocable: true };
  }
  subscribe(_h: (ev: CoreEvent) => void): () => void { return () => {}; }
  async listSessions(): Promise<SessionMeta[]> {
    this.calls.push('list');
    return this.sessions;
  }
  async resume(id?: string): Promise<SessionMeta> {
    this.calls.push(`resume:${id ?? 'latest'}`);
    if (this.failResume) throw new Error('No such session');
    return { id: id ?? 'sess-1', updatedAt: '2026-08-09T00:00:00.000Z', messageCount: 3 };
  }
}

/** Capture console.log calls while fn runs. */
async function withLogs(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (msg: unknown) => { lines.push(String(msg)); };
  try { await fn(); } finally { console.log = orig; }
  return lines;
}

/** Capture console.error calls while fn runs. */
async function withErrors(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (msg: unknown) => { lines.push(String(msg)); };
  try { await fn(); } finally { console.error = orig; }
  return lines;
}

test('/exit returns exit', async () => {
  const engine = new FakeEngine();
  assert.equal(await handleReplLine('/exit', engine), 'exit');
});

test('/skills lists skills', async () => {
  const engine = new FakeEngine();
  assert.equal(await handleReplLine('/skills', engine), 'handled');
  assert.ok(engine.calls.length === 0);
});

test('/skill-name calls loadSkill and returns handled', async () => {
  const engine = new FakeEngine();
  assert.equal(await handleReplLine('/review', engine), 'handled');
  assert.deepEqual(engine.calls, ['load:review']);
});

test('/sessions lists sessions (id, message count) and returns handled', async () => {
  const engine = new FakeEngine();
  engine.sessions = [{ id: 's1', updatedAt: '2026-08-09T10:00:00.000Z', messageCount: 4 }];
  const lines = await withLogs(async () => { assert.equal(await handleReplLine('/sessions', engine), 'handled'); });
  assert.deepEqual(engine.calls, ['list']);
  assert.ok(lines.some((l) => l.includes('s1') && l.includes('4 messages')));
  assert.ok(lines.some((l) => l.includes('/resume <id>')));
});

test('/sessions with no sessions prints a hint', async () => {
  const engine = new FakeEngine();
  const lines = await withLogs(async () => { assert.equal(await handleReplLine('/sessions', engine), 'handled'); });
  assert.ok(lines.some((l) => l.includes('No sessions')));
});

test('/resume <id> calls resume with the id', async () => {
  const engine = new FakeEngine();
  assert.equal(await handleReplLine('/resume s1', engine), 'handled');
  assert.deepEqual(engine.calls, ['resume:s1']);
});

test('/resume without an id uses the latest session', async () => {
  const engine = new FakeEngine();
  assert.equal(await handleReplLine('/resume', engine), 'handled');
  assert.deepEqual(engine.calls, ['resume:latest']);
});

test('/resume failure prints the error and returns handled', async () => {
  const engine = new FakeEngine();
  engine.failResume = true;
  const lines = await withErrors(async () => { assert.equal(await handleReplLine('/resume nope', engine), 'handled'); });
  assert.deepEqual(engine.calls, ['resume:nope']);
  assert.ok(lines.some((l) => l.includes('No such session')));
});

test('/resume and /sessions are never treated as skill loads', async () => {
  const engine = new FakeEngine();
  await handleReplLine('/resume', engine);
  await handleReplLine('/sessions', engine);
  assert.deepEqual(engine.calls, ['resume:latest', 'list']); // no load: calls
});

test('unknown /command returns handled but no crash', async () => {
  const engine = new FakeEngine();
  assert.equal(await handleReplLine('/definitely-not-a-skill', engine), 'handled');
});

test('plain prompt returns unhandled', async () => {
  const engine = new FakeEngine();
  assert.equal(await handleReplLine('hello world', engine), 'unhandled');
});

test('isNewlineKey: plain Enter (CR) is a submit, not a newline', () => {
  assert.equal(isNewlineKey({ name: 'return', sequence: '\r', ctrl: false, shift: false, meta: false }), false);
});

test('isNewlineKey: LF (Ctrl/Shift+Enter on many terminals) is a newline', () => {
  assert.equal(isNewlineKey({ name: 'enter', sequence: '\n', ctrl: false, shift: false, meta: false }), true);
});

test('isNewlineKey: CSI-u modified Enter (13;Nu, N != 1) is a newline', () => {
  // VSCode / Windows Terminal / kitty encode Ctrl+Enter as 13;5u, Shift+Enter as 13;2u.
  assert.equal(isNewlineKey({ name: undefined, sequence: '\x1b[13;5u' }), true); // Ctrl
  assert.equal(isNewlineKey({ name: undefined, sequence: '\x1b[13;2u' }), true); // Shift
  assert.equal(isNewlineKey({ name: undefined, sequence: '\x1b[13;6u' }), true); // Ctrl+Shift
});

test('isNewlineKey: bare CSI-u (13;u / 13;1u) is an unmodified Enter', () => {
  assert.equal(isNewlineKey({ name: undefined, sequence: '\x1b[13;u' }), false);
  assert.equal(isNewlineKey({ name: undefined, sequence: '\x1b[13;1u' }), false);
});

test('isNewlineKey: xterm-style modified Enter (F3 + modifier) is a newline', () => {
  assert.equal(isNewlineKey({ name: 'f3', sequence: '\x1b[13;5~', ctrl: true }), true);
  assert.equal(isNewlineKey({ name: 'f3', sequence: '\x1b[13;2~', shift: true }), true);
  assert.equal(isNewlineKey({ name: 'f3', sequence: '\x1b[13~' }), false); // plain F3
});

test('isNewlineKey: other keys and undefined are not newlines', () => {
  assert.equal(isNewlineKey(undefined), false);
  assert.equal(isNewlineKey({ name: 'a', sequence: 'a' }), false);
  assert.equal(isNewlineKey({ name: 'return', sequence: '\r', shift: true }), false);
});

test('resolveAutoApprove: --auto forces auto-approve on', () => {
  assert.equal(resolveAutoApprove({ auto: true, autoApprove: false }), true);
  assert.equal(resolveAutoApprove({ auto: true }), true);
});

test('resolveAutoApprove: config autoApprove drives the default', () => {
  assert.equal(resolveAutoApprove({ autoApprove: true }), true);
  assert.equal(resolveAutoApprove({ autoApprove: false }), false);
  assert.equal(resolveAutoApprove({}), false);
});
