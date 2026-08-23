import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AiClient, ChatParams, Message, StreamEvent } from '../../src/ai/types.ts';
import { prepareConsultHistory } from '../../src/core/consult.ts';

// ---------------------------------------------------------------- unit: history prep

const SYSTEM: Message = { role: 'system', content: [{ type: 'text', text: 'You are a delegated subagent.' }] };
const TASK: Message = { role: 'user', content: [{ type: 'text', text: 'audit the README' }] };
const REPORT: Message = { role: 'assistant', content: [{ type: 'text', text: 'README audited' }] };

test('consult history: appends question, keeps prefix byte-identical', () => {
  const src = [SYSTEM, TASK, REPORT];
  const out = prepareConsultHistory(src, 'what did you find?');
  // First three messages unchanged (deep equal) — the cache prefix survives.
  assert.deepEqual(out.slice(0, 3), src);
  assert.equal(out.length, 4);
  assert.equal(out[3].role, 'user');
  const text = out[3].content.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text).join('');
  assert.ok(text.includes('what did you find?'));
  // Source is never mutated.
  assert.equal(src.length, 3);
});

test('consult history: trims an unclosed trailing tool_call and merges into the last user turn', () => {
  const src = [
    SYSTEM,
    TASK,
    { role: 'assistant', content: [{ type: 'tool_call', id: 'c1', name: 'read', input: { path: 'x' } }] },
  ];
  const out = prepareConsultHistory(src, 'what happened?');
  // The open call is dropped; the question merges into the trailing user task.
  assert.equal(out.length, 2);
  assert.equal(out[1].role, 'user');
  const text = out[1].content.map((c) => (c as { text: string }).text).join('');
  assert.ok(text.includes('audit the README'));
  assert.ok(text.includes('what happened?'));
});

test('consult history: trims an orphaned tool_result tail too', () => {
  const src = [
    SYSTEM,
    TASK,
    { role: 'assistant', content: [{ type: 'tool_call', id: 'c1', name: 'read', input: { path: 'x' } }] },
    { role: 'user', content: [{ type: 'tool_result', toolCallId: 'c1', content: 'file body' }] },
  ];
  const out = prepareConsultHistory(src, 'q?');
  assert.equal(out.length, 2); // system + merged task/question
  assert.equal(out[1].role, 'user');
});

test('consult history: digest drops tool blocks and merges consecutive roles', () => {
  const src = [
    SYSTEM,
    { role: 'user', content: [{ type: 'text', text: 'a' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'x' }, { type: 'tool_call', id: 'c1', name: 'read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', toolCallId: 'c1', content: 'r1' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'y' }] },
    { role: 'user', content: [{ type: 'tool_result', toolCallId: 'c2', content: 'r2' }] },
  ];
  const out = prepareConsultHistory(src, 'q?', { digest: true });
  assert.deepEqual(out.map((m) => m.role), ['system', 'user', 'assistant', 'user']);
  // assistant x and y merged into one message (roles keep alternating)
  assert.deepEqual(out[2].content, [{ type: 'text', text: 'xy' }]);
  assert.equal(out[3].content.filter((c) => c.type === 'text').length, 1);
});

// ------------------------------------------------------- integration: engine + consult

/** Records every streamChat call; each call plays the next scripted step (last repeats). */
function scriptedClient(steps: Array<(params: ChatParams) => AsyncGenerator<StreamEvent>>): AiClient {
  let call = 0;
  return {
    async *streamChat(params: ChatParams) {
      yield* steps[Math.min(call++, steps.length - 1)](params);
    },
  };
}

const doneEvent = (text: string): StreamEvent => ({
  type: 'done',
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});
const callEvent = (name: string, input: Record<string, unknown>): StreamEvent => ({
  type: 'done',
  message: {
    role: 'assistant',
    content: [{ type: 'tool_call', id: `id-${name}-${Math.random().toString(36).slice(2)}`, name, input }],
  },
});

test('consult e2e: clone answers from workerB history, workerB untouched, cache prefix preserved', async () => {
  const { DaedalusEngine } = await import('../../src/core/engine.ts');
  const cloneMessages: Message[] = [];
  const client = scriptedClient([
    // 0: main delegates workerB
    async function* () { yield callEvent('delegate', { task: 'audit the README', agent: 'workerB' }); },
    // 1: workerB works and reports
    async function* () {
      yield { type: 'text_delta', text: 'README audited' };
      yield doneEvent('README audited');
    },
    // 2: main consults workerB
    async function* () { yield callEvent('consult', { agent: 'workerB', question: 'what did you find?' }); },
    // 3: the clone answers from the copied history
    async function* (params) {
      cloneMessages.push(...params.messages.map((m) => structuredClone(m)));
      yield { type: 'text_delta', text: 'I found a stale flag reference' };
      yield doneEvent('I found a stale flag reference');
    },
    // 4: main concludes
    async function* () { yield doneEvent('all done'); },
  ]);

  const engine = new DaedalusEngine({
    client,
    cwd: process.cwd(),
    askPermission: (async () => true) as (action: string, target: string) => Promise<boolean>,
    skillDirs: [],
    maxIterations: 5,
  });
  const result = await engine.run('orchestrate');
  assert.equal(result, 'all done');

  // workerB's final history: system + task + report (consult added nothing).
  const workerB = engine.getSubagentMessages('workerB');
  assert.equal(workerB.length, 3);

  // The clone's prompt = workerB history + the question turn (byte-identical prefix).
  assert.equal(cloneMessages.length, 4);
  assert.deepEqual(cloneMessages.slice(0, 3), workerB);
  assert.equal(cloneMessages[3].role, 'user');
  const qText = cloneMessages[3].content.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text).join('');
  assert.ok(qText.includes('read-only snapshot'));
  assert.ok(qText.includes('what did you find?'));

  // Main session saw both tool_results: the report and the consult answer.
  const msgs = engine.getSessionState().messages;
  const toolResults = msgs.flatMap((m) => m.content).filter((c) => c.type === 'tool_result').map((c) => (c as { content: string }).content);
  assert.deepEqual(toolResults, ['README audited', 'I found a stale flag reference']);

  // The clone left no pooled session behind: only workerB remains.
  assert.deepEqual(engine.listSubagents().map((s) => s.name), ['workerB']);
  await engine.dispose();
});

test('consult errors for an agent with no history and does not create one', async () => {
  const { DaedalusEngine } = await import('../../src/core/engine.ts');
  const client = scriptedClient([
    async function* () { yield callEvent('consult', { agent: 'ghost', question: 'hi' }); },
    async function* () { yield doneEvent('done'); },
  ]);
  const engine = new DaedalusEngine({
    client,
    cwd: process.cwd(),
    askPermission: (async () => true) as (action: string, target: string) => Promise<boolean>,
    skillDirs: [],
    maxIterations: 5,
  });
  await engine.run('ask ghost');
  const msgs = engine.getSessionState().messages;
  const result = msgs.flatMap((m) => m.content).find((c) => c.type === 'tool_result') as { content: string; isError?: boolean } | undefined;
  assert.ok(result);
  assert.match(result.content, /no session history/);
  // No pooled session was created for 'ghost'.
  assert.deepEqual(engine.listSubagents().map((s) => s.name), []);
  await engine.dispose();
});
