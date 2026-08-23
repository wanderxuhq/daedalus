import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleReplLine, isNewlineKey, resolveAutoApprove, formatElapsed, fmtTokens, runTurn } from '../../src/cli/repl.ts';
import type { TurnSink } from '../../src/cli/repl.ts';
import type { SkillInfo } from '../../src/core/skills/types.ts';
import type { SessionMeta } from '../../src/core/session-store.ts';
import type { CoreEvent } from '../../src/core/events.ts';

class FakeEngine {
  calls: string[] = [];
  sessions: SessionMeta[] = [];
  failResume = false;
  skills: SkillInfo[] = [{ name: 'review', description: 'Review code', body: 'Body', userInvocable: true }];
  usageCounts = { inputTokens: 1234, outputTokens: 567 };
  async run(prompt: string, opts?: { signal?: AbortSignal }): Promise<string> {
    this.calls.push(`run:${prompt}${opts?.signal ? ':signal' : ''}`);
    return 'done';
  }
  usage(): { inputTokens: number; outputTokens: number } {
    this.calls.push('usage');
    return { ...this.usageCounts };
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
  undoResult: { path: string; restored: boolean; message?: string } | undefined = { path: 'src/a.ts', restored: true };
  async undoLastEdit(): Promise<{ path: string; restored: boolean; message?: string } | undefined> {
    this.calls.push('undo');
    return this.undoResult;
  }
  model: string | undefined;
  autoApprove = false;
  clearDropped = 3;
  compactResult: { status: 'compacted' | 'trimmed' | 'idle'; dropped: number; kept: number } = { status: 'compacted', dropped: 2, kept: 5 };
  context = { tokens: 12_345, maxTokens: 100_000 };
  initResult: { path: string; created: boolean } = { path: '/cwd/DAEDALUS.md', created: true };
  getModel(): string | undefined {
    this.calls.push('getModel');
    return this.model;
  }
  setModel(model: string): void {
    this.calls.push(`setModel:${model}`);
    this.model = model;
  }
  getAutoApprove(): boolean {
    this.calls.push('getAutoApprove');
    return this.autoApprove;
  }
  setAutoApprove(enabled: boolean): void {
    this.calls.push(`setAutoApprove:${enabled}`);
    this.autoApprove = enabled;
  }
  clearConversation(): number {
    this.calls.push('clearConversation');
    return this.clearDropped;
  }
  async compactNow(): Promise<{ status: 'compacted' | 'trimmed' | 'idle'; dropped: number; kept: number }> {
    this.calls.push('compactNow');
    return this.compactResult;
  }
  contextUsage(): { tokens: number; maxTokens: number } {
    this.calls.push('contextUsage');
    return { ...this.context };
  }
  async initMemory(): Promise<{ path: string; created: boolean }> {
    this.calls.push('initMemory');
    return this.initResult;
  }
  planMode = false;
  getPlanMode(): boolean {
    this.calls.push('getPlanMode');
    return this.planMode;
  }
  setPlanMode(enabled: boolean): void {
    this.calls.push(`setPlanMode:${enabled}`);
    this.planMode = enabled;
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

test('/cost prints per-session token usage', async () => {
  const engine = new FakeEngine();
  const lines = await withLogs(async () => { assert.equal(await handleReplLine('/cost', engine), 'handled'); });
  assert.deepEqual(engine.calls, ['usage']);
  assert.ok(lines.some((l) => l.includes('1.2k in') && l.includes('567 out')));
});

test('/undo restores the last main-agent edit and returns handled', async () => {
  const engine = new FakeEngine();
  const lines = await withLogs(async () => { assert.equal(await handleReplLine('/undo', engine), 'handled'); });
  assert.deepEqual(engine.calls, ['undo']);
  assert.ok(lines.some((l) => l.includes('undo: restored src/a.ts')));
});

test('/undo with nothing to undo prints a hint', async () => {
  const engine = new FakeEngine();
  engine.undoResult = undefined;
  const lines = await withLogs(async () => { assert.equal(await handleReplLine('/undo', engine), 'handled'); });
  assert.ok(lines.some((l) => l.includes('Nothing to undo')));
});

test('/undo failure prints the reason', async () => {
  const engine = new FakeEngine();
  engine.undoResult = { path: 'src/a.ts', restored: false, message: 'lock held by sub' };
  const lines = await withErrors(async () => { assert.equal(await handleReplLine('/undo', engine), 'handled'); });
  assert.ok(lines.some((l) => l.includes('undo failed') && l.includes('lock held by sub')));
});

test('/clear drops the conversation and keeps the system prompt', async () => {
  const engine = new FakeEngine();
  const lines = await withLogs(async () => { assert.equal(await handleReplLine('/clear', engine), 'handled'); });
  assert.deepEqual(engine.calls, ['clearConversation']);
  assert.ok(lines.some((l) => l.includes('cleared 3 messages') && l.includes('system prompt kept')));
});

test('/clear with an empty history prints a hint', async () => {
  const engine = new FakeEngine();
  engine.clearDropped = 0;
  const lines = await withLogs(async () => { assert.equal(await handleReplLine('/clear', engine), 'handled'); });
  assert.ok(lines.some((l) => l.includes('already clean')));
});

test('/compact summarizes the oldest turns', async () => {
  const engine = new FakeEngine();
  const lines = await withLogs(async () => { assert.equal(await handleReplLine('/compact', engine), 'handled'); });
  assert.deepEqual(engine.calls, ['compactNow']);
  assert.ok(lines.some((l) => l.includes('compacted: 2 old messages summarized') && l.includes('5 kept')));
});

test('/compact when under budget reports idle', async () => {
  const engine = new FakeEngine();
  engine.compactResult = { status: 'idle', dropped: 0, kept: 5 };
  const lines = await withLogs(async () => { assert.equal(await handleReplLine('/compact', engine), 'handled'); });
  assert.ok(lines.some((l) => l.includes('nothing to compact')));
});

test('/model shows the client default when no override is set', async () => {
  const engine = new FakeEngine();
  const lines = await withLogs(async () => { assert.equal(await handleReplLine('/model', engine), 'handled'); });
  assert.deepEqual(engine.calls, ['getModel']);
  assert.ok(lines.some((l) => l.includes('client default')));
});

test('/model sets the session override', async () => {
  const engine = new FakeEngine();
  const lines = await withLogs(async () => { assert.equal(await handleReplLine('/model gpt-5', engine), 'handled'); });
  assert.deepEqual(engine.calls, ['setModel:gpt-5']);
  assert.ok(lines.some((l) => l.includes('model set to gpt-5')));
});

test('/init creates the project memory file', async () => {
  const engine = new FakeEngine();
  const lines = await withLogs(async () => { assert.equal(await handleReplLine('/init', engine), 'handled'); });
  assert.deepEqual(engine.calls, ['initMemory']);
  assert.ok(lines.some((l) => l.includes('created /cwd/DAEDALUS.md')));
});

test('/init never overwrites an existing memory file', async () => {
  const engine = new FakeEngine();
  engine.initResult = { path: '/cwd/DAEDALUS.md', created: false };
  const lines = await withLogs(async () => { assert.equal(await handleReplLine('/init', engine), 'handled'); });
  assert.ok(lines.some((l) => l.includes('already exists')));
});

test('/permissions shows the current mode', async () => {
  const engine = new FakeEngine();
  const lines = await withLogs(async () => { assert.equal(await handleReplLine('/permissions', engine), 'handled'); });
  assert.deepEqual(engine.calls, ['getAutoApprove']);
  assert.ok(lines.some((l) => l.includes('auto-approve: off')));
});

test('/permissions auto turns auto-approve on', async () => {
  const engine = new FakeEngine();
  const lines = await withLogs(async () => { assert.equal(await handleReplLine('/permissions auto', engine), 'handled'); });
  assert.deepEqual(engine.calls, ['setAutoApprove:true']);
  assert.ok(lines.some((l) => l.includes('auto-approve on')));
});

test('/permissions ask turns auto-approve off', async () => {
  const engine = new FakeEngine();
  const lines = await withLogs(async () => { assert.equal(await handleReplLine('/permissions ask', engine), 'handled'); });
  assert.deepEqual(engine.calls, ['setAutoApprove:false']);
  assert.ok(lines.some((l) => l.includes('auto-approve off')));
});

test('new slash commands are never treated as skill loads', async () => {
  const engine = new FakeEngine();
  await handleReplLine('/clear', engine);
  await handleReplLine('/model', engine);
  await handleReplLine('/init', engine);
  await handleReplLine('/permissions', engine);
  assert.deepEqual(engine.calls, ['clearConversation', 'getModel', 'initMemory', 'getAutoApprove']); // no load: calls
});

test('/plan enters plan mode', async () => {
  const engine = new FakeEngine();
  const lines = await withLogs(async () => { assert.equal(await handleReplLine('/plan', engine), 'handled'); });
  assert.deepEqual(engine.calls, ['setPlanMode:true']);
  assert.ok(lines.some((l) => l.includes('plan mode on')));
});

test('/plan off exits plan mode', async () => {
  const engine = new FakeEngine();
  const lines = await withLogs(async () => { assert.equal(await handleReplLine('/plan off', engine), 'handled'); });
  assert.deepEqual(engine.calls, ['setPlanMode:false']);
  assert.ok(lines.some((l) => l.includes('plan mode off')));
});

test('fmtTokens formats compactly', () => {
  assert.equal(fmtTokens(0), '0');
  assert.equal(fmtTokens(999), '999');
  assert.equal(fmtTokens(1_234), '1.2k');
  assert.equal(fmtTokens(12_345), '12.3k');
  assert.equal(fmtTokens(2_300_000), '2.3M');
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

test('formatElapsed: sub-second durations show ms', () => {
  assert.equal(formatElapsed(0), '0ms');
  assert.equal(formatElapsed(412), '412ms');
  assert.equal(formatElapsed(999), '999ms');
});

test('formatElapsed: seconds show one decimal', () => {
  assert.equal(formatElapsed(1000), '1.0s');
  assert.equal(formatElapsed(1234), '1.2s');
  assert.equal(formatElapsed(59_500), '59.5s');
});

test('formatElapsed: minutes show m ss', () => {
  assert.equal(formatElapsed(60_000), '1m 00s');
  assert.equal(formatElapsed(65_000), '1m 05s');
  assert.equal(formatElapsed(3_725_000), '62m 05s');
});

/* ------------------------------ runTurn ------------------------------------ */

/** Minimal engine that replays recorded CoreEvents during run(), then resolves. */
class TurnEngine {
  planMode = false;
  exitPlanOnRun = false;
  events: CoreEvent[] = [];
  result: { text?: string; error?: Error } = { text: 'done' };
  runCalls: string[] = [];
  private handlers: Array<(ev: CoreEvent) => void> = [];
  subscribe(h: (ev: CoreEvent) => void): () => void {
    this.handlers.push(h);
    return () => { this.handlers = this.handlers.filter((x) => x !== h); };
  }
  getPlanMode(): boolean {
    return this.planMode;
  }
  async run(prompt: string, _opts?: { signal?: AbortSignal }): Promise<string> {
    this.runCalls.push(prompt);
    if (this.exitPlanOnRun) this.planMode = false;
    for (const ev of this.events) for (const h of this.handlers) h(ev);
    if (this.result.error) throw this.result.error;
    return this.result.text ?? '';
  }
}

/** Recording TurnSink: every call lands in `calls` as `method:payload`. */
function makeSink(): { sink: TurnSink; calls: string[] } {
  const calls: string[] = [];
  const sink: TurnSink = {
    echoPrompt: (p) => calls.push(`prompt:${p}`),
    notice: (l) => calls.push(`notice:${l}`),
    echoAnswer: (t) => calls.push(`answer:${t}`),
    echoError: (m) => calls.push(`error:${m}`),
    setRunning: (r) => calls.push(`running:${r}`),
    flushStream: () => calls.push('flush'),
    afterTurn: () => calls.push('after'),
  };
  return { sink, calls };
}

test('runTurn: streamed deltas suppress the fallback echo; done line carries usage', async () => {
  const engine = new TurnEngine();
  engine.events = [
    { type: 'text_delta', text: 'hello ' },
    { type: 'text_delta', text: 'world' },
    { type: 'usage', inputTokens: 1000, outputTokens: 50 },
  ];
  const { sink, calls } = makeSink();
  let registered: AbortController | null = null;
  await runTurn(engine, sink, 'hi', (c) => { registered = c; return () => { registered = null; }; });
  assert.ok(calls[0].startsWith('prompt:hi'));
  assert.ok(calls.includes('running:true') && calls.includes('running:false'));
  assert.ok(calls.includes('flush'));
  assert.ok(calls.includes('after'));
  assert.ok(calls.some((c) => c.startsWith('notice:') && c.includes('✓ done')));
  assert.ok(calls.some((c) => c.startsWith('notice:') && c.includes('1.0k in · 50 out')));
  assert.ok(!calls.some((c) => c.startsWith('answer:'))); // deltas rendered
  assert.equal(registered, null); // beginRun's cleanup ran
});

test('runTurn: no deltas → the final answer is echoed as a fallback', async () => {
  const engine = new TurnEngine();
  const { sink, calls } = makeSink();
  await runTurn(engine, sink, 'q', (c) => () => { void c; });
  assert.ok(calls.some((c) => c.startsWith('answer:')));
  assert.ok(calls.some((c) => c.startsWith('answer:') && c.includes('done')));
});

test('runTurn: a subagent delta does NOT count as rendered (no fallback suppression)', async () => {
  const engine = new TurnEngine();
  engine.events = [{ type: 'text_delta', text: 'worker chatter', agent: 'worker' }];
  const { sink, calls } = makeSink();
  await runTurn(engine, sink, 'delegate', (c) => () => { void c; });
  // The main run produced no visible text → the answer must still be echoed.
  assert.ok(calls.some((c) => c.startsWith('answer:')));
});

test('runTurn: a cancellation renders the interrupted notice, not an error', async () => {
  const engine = new TurnEngine();
  engine.result.error = new DOMException('aborted', 'AbortError');
  const { sink, calls } = makeSink();
  await runTurn(engine, sink, 'stop', (c) => () => { void c; });
  assert.ok(calls.some((c) => c.startsWith('notice:') && c.includes('(interrupted')));
  assert.ok(!calls.some((c) => c.startsWith('error:')));
});

test('runTurn: a failure routes to echoError and never prints done', async () => {
  const engine = new TurnEngine();
  engine.result.error = new Error('boom');
  const { sink, calls } = makeSink();
  await runTurn(engine, sink, 'x', (c) => () => { void c; });
  assert.ok(calls.some((c) => c.startsWith('error:') && c.includes('boom')));
  assert.ok(!calls.some((c) => c.startsWith('notice:') && c.includes('✓ done')));
});

test('runTurn: leaving plan mode mid-run prints the re-enable notice', async () => {
  const engine = new TurnEngine();
  engine.planMode = true;
  engine.exitPlanOnRun = true;
  const { sink, calls } = makeSink();
  await runTurn(engine, sink, 'plan', (c) => () => { void c; });
  assert.ok(calls.some((c) => c.startsWith('notice:') && c.includes('plan mode exited')));
});
