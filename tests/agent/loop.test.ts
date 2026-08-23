import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from '../../src/agent/loop.ts';
import { Session } from '../../src/core/session.ts';
import { AiError, isCancellationError } from '../../src/ai/errors.ts';
import type { AiClient, Message } from '../../src/ai/types.ts';
import type { Tool } from '../../src/tools/types.ts';
import type { CoreEvent } from '../../src/core/events.ts';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

test('forwards a session-level model override to the client', async () => {
  let seen: string | undefined = 'not-called';
  const client: AiClient = {
    async *streamChat(params) {
      seen = params.model;
      yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } };
    },
  };
  const session = makeSession();
  await runAgent({ client, session, prompt: 'hi', tools: [], model: 'claude-test', ...CTX });
  assert.equal(seen, 'claude-test');
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

test('an empty completion ends the turn without persisting an empty assistant message', async () => {
  // Reasoning models / gateways can end a turn with no text and no tool calls
  // (only reasoning_content streamed, which is deliberately not persisted). The
  // done event is still terminal — but the resulting content:[] assistant
  // message must NOT be stored: the next request would re-send it and the API
  // rejects it ("content or tool_calls must be set").
  const client: AiClient = {
    async *streamChat() {
      yield { type: 'done', message: { role: 'assistant', content: [] } };
    },
  };
  const session = makeSession();
  const result = await runAgent({ client, session, prompt: 'hi', tools: [], ...CTX });
  assert.equal(result, '');
  const assistants = session.getMessages().filter((m) => m.role === 'assistant');
  assert.equal(assistants.length, 0);
  // the prompt is still in history; only the contentless assistant turn was dropped
  assert.ok(session.getMessages().some((m) => m.role === 'user'));
});

test('an empty-text-only completion is not persisted either', async () => {
  const client: AiClient = {
    async *streamChat() {
      yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: '' }] } };
    },
  };
  const session = makeSession();
  await runAgent({ client, session, prompt: 'hi', tools: [], ...CTX });
  const assistants = session.getMessages().filter((m) => m.role === 'assistant');
  assert.equal(assistants.length, 0);
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

test('multiple tool calls in one message run in parallel', async () => {
  // Deterministic overlap check: if the calls ran sequentially, toolB could only
  // start AFTER toolA finished (200ms later). Parallel execution makes both
  // start while the other is still running — true regardless of machine speed.
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const started: Record<string, number> = {};
  const finished: Record<string, number> = {};
  const mk = (name: string): Tool => ({
    name, description: name, inputSchema: { type: 'object' },
    async execute() {
      started[name] = Date.now();
      await delay(200);
      finished[name] = Date.now();
      return { content: name };
    },
  });
  let iterations = 0;
  const client: AiClient = {
    async *streamChat(params) {
      iterations++;
      const hasResult = params.messages.some((m) => m.role === 'user' && m.content.some((c) => c.type === 'tool_result'));
      if (!hasResult) {
        yield { type: 'done', message: { role: 'assistant', content: [
          { type: 'tool_call', id: 'a', name: 'toolA', input: {} },
          { type: 'tool_call', id: 'b', name: 'toolB', input: {} },
        ] } };
      } else {
        yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } };
      }
    },
  };
  const session = makeSession();
  await runAgent({ client, session, prompt: 'hi', tools: [mk('toolA'), mk('toolB')], ...CTX });
  assert.equal(iterations, 2);
  assert.ok(started.toolB < finished.toolA, 'toolB should start while toolA is still running');
  assert.ok(started.toolA < finished.toolB, 'toolA should start while toolB is still running');
});

test('tool results keep call order even when completion order differs', async () => {
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const slow: Tool = { name: 'slow', description: 's', inputSchema: { type: 'object' }, async execute() { await delay(150); return { content: 'SLOW' }; } };
  const fast: Tool = { name: 'fast', description: 'f', inputSchema: { type: 'object' }, async execute() { await delay(10); return { content: 'FAST' }; } };
  let secondCall: Message[] = [];
  const client: AiClient = {
    async *streamChat(params) {
      const hasResult = params.messages.some((m) => m.role === 'user' && m.content.some((c) => c.type === 'tool_result'));
      if (!hasResult) {
        // slow first, fast second — but fast finishes way earlier
        yield { type: 'done', message: { role: 'assistant', content: [
          { type: 'tool_call', id: 'slow', name: 'slow', input: {} },
          { type: 'tool_call', id: 'fast', name: 'fast', input: {} },
        ] } };
      } else {
        secondCall = params.messages;
        yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } };
      }
    },
  };
  const session = makeSession();
  await runAgent({ client, session, prompt: 'hi', tools: [slow, fast], ...CTX });
  const userMsg = secondCall.find((m) => m.role === 'user' && m.content.some((c) => c.type === 'tool_result'));
  assert.ok(userMsg);
  const blocks = userMsg.content.filter((c) => c.type === 'tool_result');
  assert.deepEqual(blocks.map((b) => b.toolCallId), ['slow', 'fast']); // call order, NOT completion order
  assert.deepEqual(blocks.map((b) => b.content), ['SLOW', 'FAST']);
});

test('a failing tool call degrades to its own error result and never aborts its siblings', async () => {
  const boom: Tool = {
    name: 'boom', description: 'b', inputSchema: { type: 'object' },
    async execute() { throw new Error('kaboom'); },
  };
  const ok: Tool = {
    name: 'ok', description: 'o', inputSchema: { type: 'object' },
    async execute() { return { content: 'FINE' }; },
  };
  let iterations = 0;
  const client: AiClient = {
    async *streamChat(params) {
      iterations++;
      const hasResult = params.messages.some((m) => m.role === 'user' && m.content.some((c) => c.type === 'tool_result'));
      if (!hasResult) {
        yield { type: 'done', message: { role: 'assistant', content: [
          { type: 'tool_call', id: 'b1', name: 'boom', input: {} },
          { type: 'tool_call', id: 'o1', name: 'ok', input: {} },
        ] } };
      } else {
        yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } };
      }
    },
  };
  const session = makeSession();
  const events: CoreEvent[] = [];
  session.bus.subscribe((ev) => events.push(ev));
  await runAgent({ client, session, prompt: 'hi', tools: [boom, ok], ...CTX });
  assert.equal(iterations, 2);
  const toolResults = events.filter((ev) => ev.type === 'tool_result');
  assert.equal(toolResults.length, 2);
  const contents = toolResults.map((ev) => (ev as { content: string }).content);
  assert.ok(contents.some((c) => c === 'FINE'));
  assert.ok(contents.some((c) => c.includes('kaboom')));
});

test('broadcasts a tool_result event per executed tool with input and content', async () => {
  let iterations = 0;
  const client: AiClient = {
    async *streamChat() {
      iterations++;
      if (iterations === 1) {
        yield { type: 'done', message: { role: 'assistant', content: [{ type: 'tool_call', id: 't1', name: 'myTool', input: { text: 'x' } }] } };
      } else {
        yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } };
      }
    },
  };
  const session = makeSession();
  const results: { name: string; content: string }[] = [];
  session.bus.subscribe((ev) => {
    if (ev.type === 'tool_result') results.push({ name: ev.name, content: ev.content });
  });
  await runAgent({ client, session, prompt: 'hi', tools: [echoTool('myTool')], ...CTX });
  assert.equal(results.length, 1);
  assert.equal(results[0].name, 'myTool');
  assert.equal(results[0].content, 'echo:x');
});

test('broadcasts a tool_result event with a file-mutation diff (UI card only)', async () => {
  let iterations = 0;
  const client: AiClient = {
    async *streamChat() {
      iterations++;
      if (iterations === 1) {
        yield { type: 'done', message: { role: 'assistant', content: [{ type: 'tool_call', id: 't1', name: 'editTool', input: { path: 'x.ts' } }] } };
      } else {
        yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } };
      }
    },
  };
  const session = makeSession();
  const diff = '@@ -1,1 +1,1 @@\n-old\n+new';
  const results: { name: string; content: string; diff?: string }[] = [];
  session.bus.subscribe((ev) => {
    if (ev.type === 'tool_result') results.push({ name: ev.name, content: ev.content, diff: ev.diff });
  });
  const diffTool: Tool = {
    name: 'editTool',
    description: 'edit',
    inputSchema: { type: 'object' },
    async execute() {
      return { content: 'Edited x.ts', diff };
    },
  };
  await runAgent({ client, session, prompt: 'hi', tools: [diffTool], ...CTX });
  assert.equal(results.length, 1);
  assert.equal(results[0].name, 'editTool');
  assert.equal(results[0].diff, diff);
});

test('PreToolUse hook can deny a tool call', async () => {
  let iterations = 0;
  let executed = false;
  const client: AiClient = {
    async *streamChat() {
      iterations++;
      if (iterations === 1) {
        yield { type: 'done', message: { role: 'assistant', content: [{ type: 'tool_call', id: 't1', name: 'myTool', input: { text: 'x' } }] } };
      } else {
        yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } };
      }
    },
  };
  const session = makeSession();
  const deniedTool: Tool = {
    name: 'myTool',
    description: 'x',
    inputSchema: { type: 'object' },
    async execute() { executed = true; return { content: 'ran' }; },
  };
  const results: { content: string; isError?: boolean }[] = [];
  session.bus.subscribe((ev) => { if (ev.type === 'tool_result') results.push({ content: ev.content, isError: ev.isError }); });
  const hooks = {
    preToolUse: [{ matcher: '^myTool\n', command: 'node -e "process.stdout.write(JSON.stringify({permissionDecision:\'deny\', reason:\'blocked by policy\'}))"' }],
  };
  const out = await runAgent({ client, session, prompt: 'hi', tools: [deniedTool], hooks, ...CTX });
  assert.equal(out, 'done');
  assert.equal(executed, false, 'the tool must not run when a hook denies it');
  assert.equal(results.length, 1);
  assert.equal(results[0].isError, true);
  assert.ok(results[0].content.includes('Hook denied myTool'));
  assert.ok(results[0].content.includes('blocked by policy'));
});

test('PostToolUse hook observes the completed call', async () => {
  const dir = join(tmpdir(), `dae-ptu-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const marker = join(dir, 'post.txt');
  let iterations = 0;
  const client: AiClient = {
    async *streamChat() {
      iterations++;
      if (iterations === 1) {
        yield { type: 'done', message: { role: 'assistant', content: [{ type: 'tool_call', id: 't1', name: 'myTool', input: { text: 'x' } }] } };
      } else {
        yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } };
      }
    },
  };
  const session = makeSession();
  const hooks = {
    postToolUse: [{ matcher: '^myTool\n', command: `node -e "require('fs').writeFileSync(process.argv[1], 'post-ran')" ${JSON.stringify(marker)}` }],
  };
  await runAgent({ client, session, prompt: 'hi', tools: [echoTool('myTool')], hooks, ...CTX });
  assert.equal(readFileSync(marker, 'utf8'), 'post-ran');
  rmSync(dir, { recursive: true, force: true });
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

test('a failed run after auto-compaction still rolls back to a valid state', async () => {
  const session = makeSession();
  session.addMessage({ role: 'system', content: [{ type: 'text', text: 'sys' }] });
  session.addMessage({ role: 'user', content: [{ type: 'text', text: 'p1' }] });
  session.addMessage({ role: 'assistant', content: [{ type: 'text', text: 'a1' }] });
  session.addMessage({ role: 'user', content: [{ type: 'text', text: 'p2' }] });
  session.addMessage({ role: 'assistant', content: [{ type: 'text', text: 'a2' }] });
  let calls = 0;
  const client: AiClient = {
    async *streamChat(params) {
      calls++;
      const isCompactor = params.messages.some((m) => m.role === 'system' && m.content.some(
        (c) => c.type === 'text' && c.text.startsWith('You are a conversation compactor'),
      ));
      if (isCompactor) {
        yield { type: 'text_delta', text: 'COMPACTED SUMMARY' };
        yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'COMPACTED SUMMARY' }] } };
      } else {
        yield { type: 'error', error: new AiError('network', 'connection lost') };
      }
    },
  };
  await assert.rejects(() => runAgent({ client, session, prompt: 'p3', tools: [], ...CTX, maxContextTokens: 10 }), /connection lost/);
  const msgs = session.getMessages();
  // The compaction DID run (the summary call was made), then the real request
  // failed. The rollback must not leave an orphaned user prompt or a trailing
  // summary: a later run() must be able to inject a fresh prompt.
  assert.notEqual(msgs[msgs.length - 1].role, 'user', 'session must not end with the orphaned prompt');
  assert.ok(!msgs.some((m) => m.content.some((c) => c.type === 'text' && c.text.includes('COMPACTED SUMMARY'))), 'failed turn, summary included, rolled back');
  assert.ok(calls >= 2, 'compaction ran before the failing request');
});

test('compacts over-budget history via the model and emits context_compact', async () => {
  const session = makeSession();
  session.addMessage({ role: 'system', content: [{ type: 'text', text: 'sys' }] });
  session.addMessage({ role: 'user', content: [{ type: 'text', text: 'p1' }] });
  session.addMessage({ role: 'assistant', content: [{ type: 'text', text: 'a1' }] });
  session.addMessage({ role: 'user', content: [{ type: 'text', text: 'p2' }] });
  session.addMessage({ role: 'assistant', content: [{ type: 'text', text: 'a2' }] });
  let calls = 0;
  const client: AiClient = {
    async *streamChat(params) {
      calls++;
      const isCompactor = params.messages.some((m) => m.role === 'system' && m.content.some(
        (c) => c.type === 'text' && c.text.startsWith('You are a conversation compactor'),
      ));
      if (isCompactor) {
        yield { type: 'text_delta', text: 'COMPACTED SUMMARY' };
        yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'COMPACTED SUMMARY' }] } };
      } else {
        yield { type: 'text_delta', text: 'final' };
        yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'final' }] } };
      }
    },
  };
  const events: string[] = [];
  session.bus.subscribe((ev) => events.push(ev.type));
  const result = await runAgent({ client, session, prompt: 'p3', tools: [], ...CTX, maxContextTokens: 10 });
  assert.equal(result, 'final');
  assert.ok(calls >= 2, `expected a compactor call + a main call, got ${calls}`);
  const history = JSON.stringify(session.getMessages());
  assert.ok(history.includes('COMPACTED SUMMARY')); // summary merged in, nothing lost
  assert.ok(history.includes('p3'));
  assert.ok(events.includes('context_compact'));
  assert.ok(!events.includes('context_trim'));
});

test('falls back to a hard trim when the summarizer fails', async () => {
  const session = makeSession();
  session.addMessage({ role: 'system', content: [{ type: 'text', text: 'sys' }] });
  session.addMessage({ role: 'user', content: [{ type: 'text', text: 'p1' }] });
  session.addMessage({ role: 'assistant', content: [{ type: 'text', text: 'a1' }] });
  session.addMessage({ role: 'user', content: [{ type: 'text', text: 'p2' }] });
  session.addMessage({ role: 'assistant', content: [{ type: 'text', text: 'a2' }] });
  let calls = 0;
  const client: AiClient = {
    async *streamChat(params) {
      calls++;
      const isCompactor = params.messages.some((m) => m.role === 'system' && m.content.some(
        (c) => c.type === 'text' && c.text.startsWith('You are a conversation compactor'),
      ));
      if (isCompactor) {
        yield { type: 'error', error: new AiError('network', 'summarizer down') };
      } else {
        yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } };
      }
    },
  };
  const events: string[] = [];
  session.bus.subscribe((ev) => events.push(ev.type));
  await runAgent({ client, session, prompt: 'p3', tools: [], ...CTX, maxContextTokens: 1 });
  assert.ok(calls >= 2);
  assert.ok(events.includes('context_trim')); // lossy fallback used
  const history = JSON.stringify(session.getMessages());
  assert.ok(!history.includes('p1'));
  assert.ok(history.includes('p3'));
});

test('forwards usage stream events as core events', async () => {
  const session = makeSession();
  const client: AiClient = {
    async *streamChat() {
      yield { type: 'usage', inputTokens: 100, outputTokens: 50 };
      yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } };
    },
  };
  const got: CoreEvent[] = [];
  session.bus.subscribe((ev) => got.push(ev));
  await runAgent({ client, session, prompt: 'hi', tools: [], ...CTX });
  const usage = got.find((ev) => ev.type === 'usage');
  assert.deepEqual(usage, { type: 'usage', inputTokens: 100, outputTokens: 50 });
});

test('abort signal is passed to streamChat and surfaces as a cancellation error', async () => {
  const session = makeSession();
  const ac = new AbortController();
  let gotSignal: AbortSignal | undefined;
  const client: AiClient = {
    async *streamChat(params) {
      gotSignal = params.signal;
      yield { type: 'error', error: new AiError('timeout', 'Request cancelled by caller') };
    },
  };
  await assert.rejects(
    () => runAgent({ client, session, prompt: 'hi', tools: [], ...CTX, signal: ac.signal }),
    (e: unknown) => isCancellationError(e),
  );
  assert.ok(gotSignal === ac.signal);
});

test('isCancellationError also recognizes the DOM AbortError thrown mid-stream', () => {
  // A mid-stream abort rejects the body reader with the DOM's raw AbortError
  // ("This operation was aborted"), which the providers rethrow untouched — the
  // REPL must classify it as an interrupt, not a red error.
  const abort = new DOMException('This operation was aborted', 'AbortError');
  assert.equal(isCancellationError(abort), true);
  assert.equal(isCancellationError(new AiError('timeout', 'Request cancelled by caller')), true);
  assert.equal(isCancellationError(new Error('network hiccup')), false);
  assert.equal(isCancellationError(new AiError('server', '500')), false);
});
