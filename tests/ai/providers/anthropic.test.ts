import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { toAnthropicBody, anthropicEventsToIR, createAnthropicClient } from '../../../src/ai/providers/anthropic.ts';
import type { Message, ToolDefinition, StreamEvent } from '../../../src/ai/types.ts';

test('converts IR system+text to anthropic body', () => {
  const messages: Message[] = [
    { role: 'system', content: [{ type: 'text', text: 'You are helpful' }] },
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
  ];
  const tools: ToolDefinition[] = [{ name: 'bash', description: 'run', inputSchema: { type: 'object' } }];
  const body = toAnthropicBody({ model: 'claude-sonnet-4-5', messages, tools, maxTokens: 2048, cache: { enabled: false } });
  assert.equal(body.system, 'You are helpful');
  assert.equal(body.messages[0].role, 'user');
  assert.equal(body.messages[0].content[0].type, 'text');
  assert.equal(body.max_tokens, 2048);
  assert.equal(body.stream, true);
  assert.equal(body.tools[0].input_schema.type, 'object');
});

test('marks cache_control on stable blocks when cache enabled', () => {
  const messages: Message[] = [
    { role: 'system', content: [{ type: 'text', text: 'sys' }] },
    { role: 'user', content: [{ type: 'text', text: 'u' }] },
  ];
  const body = toAnthropicBody({ model: 'm', messages, cache: { enabled: true } });
  assert.deepEqual((body.system as Record<string, unknown>[])[0].cache_control, { type: 'ephemeral' });
  assert.deepEqual((body.messages as Record<string, unknown>[])[(body.messages as unknown[]).length - 1].cache_control, { type: 'ephemeral' });
});

test('converts tool_call and tool_result blocks', () => {
  const messages: Message[] = [
    { role: 'assistant', content: [{ type: 'tool_call', id: 't1', name: 'bash', input: { command: 'ls' } }] },
    { role: 'user', content: [{ type: 'tool_result', toolCallId: 't1', content: 'out', isError: false }] },
  ];
  const body = toAnthropicBody({ model: 'm', messages });
  assert.equal(body.messages[0].content[0].type, 'tool_use');
  assert.equal(body.messages[0].content[0].id, 't1');
  assert.equal(body.messages[1].content[0].type, 'tool_result');
  assert.equal(body.messages[1].content[0].tool_use_id, 't1');
});

test('converts anthropic SSE payloads to IR events', () => {
  const payloads = [
    { type: 'message_start', message: { id: 'm1' } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't1', name: 'bash', input: {} } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"c' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'ommand":"ls"}' } },
    { type: 'message_stop' },
  ];
  const events = anthropicEventsToIR(payloads);
  const types = events.map((e) => e.type);
  assert.deepEqual(types, [
    'text_delta', 'text_delta', 'tool_call_start', 'tool_call_delta', 'tool_call_delta', 'done',
  ]);
  const done = events.find((e) => e.type === 'done')!;
  assert.equal(done.type, 'done');
  const tc = done.message.content.find((c) => c.type === 'tool_call')!;
  assert.equal(tc.type, 'tool_call');
  assert.deepEqual(tc.input, { command: 'ls' });
});

test('streamChat accumulates blocks across SSE payloads into a full done message', async () => {
  const origFetch = globalThis.fetch;
  const payloads = [
    { type: 'message_start', message: { id: 'm1' } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't1', name: 'bash', input: {} } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"c' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'ommand":"ls"}' } },
    { type: 'message_stop' },
  ];
  const sseChunks = payloads.map((p) => `data: ${JSON.stringify(p)}\n\n`);
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

  const client = createAnthropicClient({ apiKey: 'k', baseURL: 'https://x', maxRetries: 0 });
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
  assert.deepEqual(types, [
    'text_delta', 'text_delta', 'tool_call_start', 'tool_call_delta', 'tool_call_delta', 'done',
  ]);
  const done = events.find((e) => e.type === 'done')!;
  assert.equal(done.type, 'done');
  const text = done.message.content.find((c) => c.type === 'text')!;
  assert.equal(text.type, 'text');
  assert.equal(text.text, 'Hello');
  const tc = done.message.content.find((c) => c.type === 'tool_call')!;
  assert.equal(tc.type, 'tool_call');
  assert.deepEqual(tc.input, { command: 'ls' });
});
