import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from '../../src/agent/loop.ts';
import { Session } from '../../src/core/session.ts';
import { AiError } from '../../src/ai/errors.ts';
import type { AiClient } from '../../src/ai/types.ts';
import type { Tool } from '../../src/tools/types.ts';
import type { CoreEvent } from '../../src/core/events.ts';

function makeSession(): Session {
  const s = new Session();
  s.start();
  return s;
}

const CTX = { cwd: process.cwd(), askPermission: (async () => true) as (action: string, target: string) => Promise<boolean> };

function echoTool(name: string): Tool {
  return {
    name,
    description: 'echo',
    inputSchema: { type: 'object' },
    async execute(input: unknown) {
      const args = input as { text?: string };
      return { content: `echo:${args.text ?? ''}` };
    },
  };
}

test('no tool calls → returns assistant text and ends', async () => {
  const client: AiClient = {
    async *streamChat() {
      yield { type: 'text_delta', text: 'hello' };
      yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } };
    },
  };
  const session = makeSession();
  const result = await runAgent({ client, session, prompt: 'hi', tools: [], ...CTX });
  assert.equal(result, 'hello');
});

test('delivers the user prompt to streamChat as a user message', async () => {
  const client: AiClient = {
    async *streamChat(params) {
      const userMsg = params.messages.find((m) => m.role === 'user' && m.content.some((c) => c.type === 'text'));
      if (!userMsg) throw new Error('no user message in messages');
      const textBlock = userMsg.content.find((c) => c.type === 'text');
      if (textBlock?.type !== 'text' || textBlock.text !== 'hi') throw new Error('user prompt mismatch');
      yield { type: 'text_delta', text: 'ok' };
      yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } };
    },
  };
  const session = makeSession();
  const result = await runAgent({ client, session, prompt: 'hi', tools: [], ...CTX });
  assert.equal(result, 'ok');
});

test('tool call → executes tool → returns tool result to AI → final text', async () => {
  let iterations = 0;
  const client: AiClient = {
    async *streamChat(params) {
      iterations++;
      if (iterations === 1) {
        yield { type: 'tool_call_start', id: 't1', name: 'myTool' };
        yield { type: 'tool_call_delta', id: 't1', inputDelta: '{"text":"x"}' };
        yield { type: 'done', message: { role: 'assistant', content: [{ type: 'tool_call', id: 't1', name: 'myTool', input: { text: 'x' } }] } };
      } else {
        const userMsg = params.messages.find((m) => m.role === 'user' && m.content.some((c) => c.type === 'tool_result'));
        assert.ok(userMsg);
        yield { type: 'text_delta', text: 'done' };
        yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } };
      }
    },
  };
  const session = makeSession();
  const result = await runAgent({ client, session, prompt: 'hi', tools: [echoTool('myTool')], ...CTX });
  assert.equal(result, 'done');
  assert.equal(iterations, 2);
});

test('tool execution receives cwd and askPermission from params', async () => {
  let gotCwd = '';
  let askCalled = false;
  const tool: Tool = {
    name: 'ctxTool',
    description: 'ctx',
    inputSchema: { type: 'object' },
    async execute(_input, ctx) {
      gotCwd = ctx.cwd;
      askCalled = await ctx.askPermission('test', 'target');
      return { content: 'ok' };
    },
  };
  const client: AiClient = {
    async *streamChat(params) {
      const hasResult = params.messages.some((m) => m.role === 'user' && m.content.some((c) => c.type === 'tool_result'));
      if (!hasResult) {
        yield { type: 'done', message: { role: 'assistant', content: [{ type: 'tool_call', id: 't', name: 'ctxTool', input: {} }] } };
      } else {
        yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'final' }] } };
      }
    },
  };
  const session = makeSession();
  await runAgent({ client, session, prompt: 'hi', tools: [tool], cwd: '/tmp/ctx', askPermission: async () => { return true; } });
  assert.equal(gotCwd, '/tmp/ctx');
  assert.equal(askCalled, true);
});

test('stops after maxIterations', async () => {
  let iterations = 0;
  const client: AiClient = {
    async *streamChat() {
      iterations++;
      yield { type: 'done', message: { role: 'assistant', content: [{ type: 'tool_call', id: 't', name: 'myTool', input: {} }] } };
    },
  };
  const session = makeSession();
  const result = await runAgent({ client, session, prompt: 'hi', tools: [echoTool('myTool')], ...CTX, maxIterations: 2 });
  assert.equal(iterations, 2);
  assert.equal(result, '');
});

test('throws AiError when streamChat ends without a terminal done or error event', async () => {
  const client: AiClient = {
    async *streamChat() {
      yield { type: 'text_delta', text: 'orphan' };
    },
  };
  const session = makeSession();
  await assert.rejects(
    () => runAgent({ client, session, prompt: 'hi', tools: [], ...CTX, maxIterations: 2 }),
    (e: unknown) => e instanceof AiError && e.kind === 'protocol',
  );
});

test('broadcasts stream events as core events on session bus', async () => {
  const client: AiClient = {
    async *streamChat() {
      yield { type: 'text_delta', text: 'hi' };
      yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } };
    },
  };
  const session = makeSession();
  const got: string[] = [];
  session.bus.subscribe((ev: CoreEvent) => got.push(ev.type));
  await runAgent({ client, session, prompt: 'hi', tools: [], ...CTX });
  assert.ok(got.includes('text_delta'));
  assert.ok(got.includes('done'));
});

test('messages accumulate in session across consecutive runAgent calls', async () => {
  const session = makeSession();
  await runAgent({
    client: {
      async *streamChat() {
        yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'one' }] } };
      },
    },
    session, prompt: 'first', tools: [], ...CTX,
  });
  let sawPrior = false;
  await runAgent({
    client: {
      async *streamChat(params) {
        sawPrior = params.messages.some((m) => m.role === 'assistant' && JSON.stringify(m.content).includes('one'));
        yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'two' }] } };
      },
    },
    session, prompt: 'second', tools: [], ...CTX,
  });
  assert.equal(sawPrior, true);
});

test('trims old turns when over budget and emits context_trim', async () => {
  const seen: string[] = [];
  const session = makeSession();
  session.addMessage({ role: 'system', content: [{ type: 'text', text: 'sys' }] });
  const client: AiClient = {
    async *streamChat(params) {
      seen.push(JSON.stringify(params.messages));
      yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } };
    },
  };
  const got: string[] = [];
  session.bus.subscribe((ev) => { if (ev.type === 'context_trim') got.push(`${ev.dropped}/${ev.kept}`); });
  await runAgent({ client, session, prompt: 'p1', tools: [], ...CTX, maxContextTokens: 10 });
  await runAgent({ client, session, prompt: 'p2', tools: [], ...CTX, maxContextTokens: 10 });
  await runAgent({ client, session, prompt: 'p3', tools: [], ...CTX, maxContextTokens: 10 });
  const last = seen[seen.length - 1];
  assert.ok(!last.includes('p1'));      // oldest turn trimmed before run 3's request
  assert.ok(last.includes('p3'));       // newest prompt kept
  assert.ok(got.length >= 1);           // at least one context_trim emitted
});

test('a failed run rolls back the turn (no orphaned prompt left in history)', async () => {
  const session = makeSession();
  session.addMessage({ role: 'system', content: [{ type: 'text', text: 'sys' }] });
  const client: AiClient = {
    async *streamChat() {
      yield { type: 'error', error: new AiError('api', 'boom') };
    },
  };
  await assert.rejects(() => runAgent({ client, session, prompt: 'hi', tools: [], ...CTX }), /boom/);
  const msgs = session.getMessages();
  assert.equal(msgs.length, 1); // system only — the prompt was rolled back
  assert.equal(msgs[0].role, 'system');
});
