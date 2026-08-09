import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { toOpenAIBody, openaiEventsToIR, createOpenAIClient } from '../../../src/ai/providers/openai.ts';
import type { Message, ToolDefinition, StreamEvent } from '../../../src/ai/types.ts';

test('converts system+user to openai body', () => {
  const messages: Message[] = [
    { role: 'system', content: [{ type: 'text', text: 'You are helpful' }] },
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
  ];
  const body = toOpenAIBody({ model: 'gpt-4o', messages });
  assert.equal(body.stream, true);
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages[0].content, 'You are helpful');
  assert.equal(body.messages[1].role, 'user');
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
