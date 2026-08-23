import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { toOpenAIBody, openaiEventsToIR, createOpenAIClient } from '../../../src/ai/providers/openai.ts';
import { AiError } from '../../../src/ai/errors.ts';
import type { Message, ToolDefinition, StreamEvent } from '../../../src/ai/types.ts';

test('converts system+user to openai body', () => {
  const messages: Message[] = [
    { role: 'system', content: [{ type: 'text', text: 'You are helpful' }] },
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
  ];
  const body = toOpenAIBody({ model: 'gpt-4o', messages });
  assert.equal(body.stream, true);
  // Ask for the usage object on the final chunk so per-turn tokens are visible.
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages[0].content, 'You are helpful');
  assert.equal(body.messages[1].role, 'user');
});

test('usage: final chunk with usage becomes a usage event', () => {
  const events = openaiEventsToIR([
    { choices: [{ delta: { content: 'Hi' } }] },
    { choices: [], usage: { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49 } },
  ]);
  const types = events.map((e) => e.type);
  assert.deepEqual(types, ['text_delta', 'usage', 'done']);
  const usage = events.find((e) => e.type === 'usage');
  assert.deepEqual(usage, { type: 'usage', inputTokens: 42, outputTokens: 7 });
});

test('converts tool_call and tool_result to openai format', () => {
  const messages: Message[] = [
    { role: 'assistant', content: [{ type: 'tool_call', id: 't1', name: 'bash', input: { command: 'ls' } }] },
    { role: 'user', content: [{ type: 'tool_result', toolCallId: 't1', content: 'out' }] },
  ];
  const body = toOpenAIBody({ model: 'm', messages });
  assert.equal(body.messages[0].content, null);
  assert.equal(body.messages[0].tool_calls[0].function.name, 'bash');
  assert.equal(body.messages[0].tool_calls[0].function.arguments, '{"command":"ls"}');
  assert.equal(body.messages[1].role, 'tool');
  assert.equal(body.messages[1].tool_call_id, 't1');
});

test('converts tool definitions', () => {
  const tools: ToolDefinition[] = [{ name: 'bash', description: 'run', inputSchema: { type: 'object' } }];
  const body = toOpenAIBody({ model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }], tools });
  assert.equal(body.tools[0].type, 'function');
  assert.equal(body.tools[0].function.parameters.type, 'object');
});

test('reasoning_effort: omitted without an explicit budget; strict tier mapping', () => {
  const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }];
  const plain = toOpenAIBody({ model: 'm', messages });
  assert.equal('reasoning_effort' in plain, false);
  // No budget configured → omit the field entirely. Endpoints apply their own
  // default, and gateways whose models force-enable reasoning (e.g. opencode
  // zen, error [1210]) reject explicit efforts outside low/high/max.
  const noBudget = toOpenAIBody({ model: 'm', messages, thinking: { enabled: true } });
  assert.equal('reasoning_effort' in noBudget, false);
  const low = toOpenAIBody({ model: 'm', messages, thinking: { enabled: true, budgetTokens: 512 } });
  assert.equal(low.reasoning_effort, 'low');
  // Mid budgets fold into "low": "medium" is rejected by the strictest
  // compatible gateway, so the tier set is the low/high intersection.
  const mid = toOpenAIBody({ model: 'm', messages, thinking: { enabled: true, budgetTokens: 4096 } });
  assert.equal(mid.reasoning_effort, 'low');
  const high = toOpenAIBody({ model: 'm', messages, thinking: { enabled: true, budgetTokens: 16384 } });
  assert.equal(high.reasoning_effort, 'high');
});

test('reasoning_content deltas stream as thinking_delta but are not persisted in done', () => {
  const events = openaiEventsToIR([
    { choices: [{ index: 0, delta: { reasoning_content: 'Let me ' } }] },
    { choices: [{ index: 0, delta: { reasoning_content: 'think.' } }] },
    { choices: [{ index: 0, delta: { content: 'Hello' } }] },
  ]);
  const types = events.map((e) => e.type);
  assert.deepEqual(types, ['thinking_delta', 'thinking_delta', 'text_delta', 'done']);
  const done = events.find((e) => e.type === 'done')!;
  assert.equal(done.type, 'done');
  assert.deepEqual(done.message.content, [{ type: 'text', text: 'Hello' }]);
});

test('converts openai SSE payloads to IR events', () => {
  const payloads = [
    { choices: [{ delta: { content: 'Hi' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 't1', type: 'function', function: { name: 'bash', arguments: '{"com' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'mand":"ls"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ];
  const events = openaiEventsToIR(payloads);
  const types = events.map((e) => e.type);
  assert.deepEqual(types, ['text_delta', 'tool_call_start', 'tool_call_delta', 'tool_call_delta', 'done']);
  const done = events.find((e) => e.type === 'done')!;
  assert.equal(done.type, 'done');
  const tc = done.message.content.find((c) => c.type === 'tool_call')!;
  assert.equal(tc.type, 'tool_call');
  assert.deepEqual(tc.input, { command: 'ls' });
});

test('streamChat accumulates deltas across SSE payloads into a full done message', async () => {
  const origFetch = globalThis.fetch;
  const payloads = [
    { choices: [{ delta: { content: 'Hi' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 't1', type: 'function', function: { name: 'bash', arguments: '{"com' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'mand":"ls"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ];
  const sseChunks = payloads.map((p) => `data: ${JSON.stringify(p)}\n\n`).concat('data: [DONE]\n\n');
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of sseChunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
  let sentBody: Record<string, unknown> | undefined;
  globalThis.fetch = mock.fn(async (_url: unknown, init?: { body?: string }) => {
    sentBody = init?.body ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    return new Response(stream, { status: 200 });
  }) as typeof fetch;

  const client = createOpenAIClient({ apiKey: 'k', baseURL: 'https://x', maxRetries: 0 });
  const events: StreamEvent[] = [];
  for await (const ev of client.streamChat({
    model: 'm',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  })) {
    events.push(ev);
  }
  globalThis.fetch = origFetch;

  assert.equal(sentBody?.stream, true);
  const types = events.map((e) => e.type);
  assert.deepEqual(types, ['text_delta', 'tool_call_start', 'tool_call_delta', 'tool_call_delta', 'done']);
  const done = events.find((e) => e.type === 'done')!;
  assert.equal(done.type, 'done');
  const text = done.message.content.find((c) => c.type === 'text')!;
  assert.equal(text.type, 'text');
  assert.equal(text.text, 'Hi');
  const tc = done.message.content.find((c) => c.type === 'tool_call')!;
  assert.equal(tc.type, 'tool_call');
  assert.deepEqual(tc.input, { command: 'ls' });
});

test('streamChat flushes and yields an error event when the stream ends with a top-level error payload (no [DONE])', async () => {
  const origFetch = globalThis.fetch;
  // OpenAI sends a top-level `data: {"error": {...}}` on mid-stream errors and
  // does NOT send [DONE] afterwards — the accumulated text must still be flushed.
  const payloads = [
    { choices: [{ delta: { content: 'partial ' } }] },
    { choices: [{ delta: { content: 'output' } }] },
    { error: { message: 'boom: mid-stream failure' } },
  ];
  const sseChunks = payloads.map((p) => `data: ${JSON.stringify(p)}\n\n`);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of sseChunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
  globalThis.fetch = mock.fn(async () => new Response(stream, { status: 200 })) as typeof fetch;

  const client = createOpenAIClient({ apiKey: 'k', baseURL: 'https://x', maxRetries: 0 });
  const events: StreamEvent[] = [];
  for await (const ev of client.streamChat({
    model: 'm',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  })) {
    events.push(ev);
  }
  globalThis.fetch = origFetch;

  // Batch text before the error is still flushed, and the error event surfaces.
  const types = events.map((e) => e.type);
  assert.deepEqual(types, ['text_delta', 'text_delta', 'error']);
  const errEv = events.find((e) => e.type === 'error');
  assert.ok(errEv && errEv.type === 'error');
  assert.ok(errEv.error instanceof AiError);
  assert.equal(errEv.error.message, 'boom: mid-stream failure');
  assert.equal(errEv.error.kind, 'server');
});

test('streamChat emits a terminal done event for an empty completion (no text, no tool calls)', async () => {
  const origFetch = globalThis.fetch;
  // Empty completions happen (content filters, local models, max_tokens=0):
  // the delta carries only finish_reason, then [DONE]. The adapter must still
  // terminate with a 'done' event — otherwise runAgent throws the protocol
  // error "stream ended without a terminal done or error event".
  const payloads = [{ choices: [{ delta: {}, finish_reason: 'stop' }] }];
  const sseChunks = payloads.map((p) => `data: ${JSON.stringify(p)}\n\n`).concat('data: [DONE]\n\n');
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of sseChunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
  globalThis.fetch = mock.fn(async () => new Response(stream, { status: 200 })) as typeof fetch;

  const client = createOpenAIClient({ apiKey: 'k', baseURL: 'https://x', maxRetries: 0 });
  const events: StreamEvent[] = [];
  for await (const ev of client.streamChat({
    model: 'm',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  })) {
    events.push(ev);
  }
  globalThis.fetch = origFetch;

  const types = events.map((e) => e.type);
  assert.deepEqual(types, ['done']);
  const done = events.find((e) => e.type === 'done');
  assert.ok(done && done.type === 'done');
  assert.deepEqual(done.message.content, []);
});

test('streamChat flushes accumulated output when the stream closes WITHOUT a [DONE] sentinel', async () => {
  const origFetch = globalThis.fetch;
  // Some OpenAI-compatible servers (Ollama, vLLM, custom gateways) close the
  // connection after the last chunk without sending `data: [DONE]` — the
  // accumulated deltas must still be emitted as a terminal 'done' message
  // instead of being swallowed (which previously ended in a protocol error).
  const payloads = [
    { choices: [{ delta: { content: 'Hello' } }] },
    { choices: [{ delta: { content: ' no-DONE' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
  ];
  const sseChunks = payloads.map((p) => `data: ${JSON.stringify(p)}\n\n`);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of sseChunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
  globalThis.fetch = mock.fn(async () => new Response(stream, { status: 200 })) as typeof fetch;

  const client = createOpenAIClient({ apiKey: 'k', baseURL: 'https://x', maxRetries: 0 });
  const events: StreamEvent[] = [];
  for await (const ev of client.streamChat({
    model: 'm',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  })) {
    events.push(ev);
  }
  globalThis.fetch = origFetch;

  // Deltas streamed live, and a clean close emits the terminal 'done' from the
  // accumulated state — the response is not lost.
  const types = events.map((e) => e.type);
  assert.deepEqual(types, ['text_delta', 'text_delta', 'done']);
  const done = events.find((e) => e.type === 'done')!;
  assert.equal(done.type, 'done');
  const text = done.message.content.find((c) => c.type === 'text')!;
  assert.equal(text.type, 'text');
  assert.equal(text.text, 'Hello no-DONE');
});
