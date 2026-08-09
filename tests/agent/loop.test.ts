import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from '../../src/agent/loop.ts';
import type { AiClient, StreamEvent, Message } from '../../src/ai/types.ts';
import type { Tool } from '../../src/tools/types.ts';

function echoTool(name: string, input: Record<string, unknown>): Tool {
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
  const result = await runAgent({ client, systemPrompt: 'sys', tools: [], cwd: process.cwd(), askPermission: async () => true });
  assert.equal(result, 'hello');
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
        // second call sees the tool_result in history
        const userMsg = params.messages.find((m) => m.role === 'user');
        assert.ok(userMsg);
        const hasResult = userMsg.content.some((c) => c.type === 'tool_result');
        assert.equal(hasResult, true);
        yield { type: 'text_delta', text: 'done' };
        yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } };
      }
    },
  };
  const tool = echoTool('myTool', {});
  const result = await runAgent({ client, systemPrompt: 'sys', tools: [tool], cwd: process.cwd(), askPermission: async () => true });
  assert.equal(result, 'done');
  assert.equal(iterations, 2);
});

test('stops after maxIterations', async () => {
  let iterations = 0;
  const client: AiClient = {
    async *streamChat() {
      iterations++;
      yield { type: 'done', message: { role: 'assistant', content: [{ type: 'tool_call', id: 't', name: 'myTool', input: {} }] } };
    },
  };
  const tool = echoTool('myTool', {});
  const result = await runAgent({ client, systemPrompt: 'sys', tools: [tool], cwd: process.cwd(), askPermission: async () => true, maxIterations: 2 });
  assert.equal(iterations, 2);
  assert.equal(result, '');
});
