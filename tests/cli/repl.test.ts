import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleReplLine, isNewlineKey } from '../../src/cli/repl.ts';
import type { SkillInfo } from '../../src/core/skills/types.ts';
import type { CoreEvent } from '../../src/core/events.ts';

class FakeEngine {
  calls: string[] = [];
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
