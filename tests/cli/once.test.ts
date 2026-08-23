import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AiClient, ChatParams, StreamEvent } from '../../src/ai/types.ts';
import { runOnce } from '../../src/cli/once.ts';

/** Each call plays the next scripted step (last repeats). */
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

async function makeEngine(client: AiClient) {
  const { DaedalusEngine } = await import('../../src/core/engine.ts');
  const engine = new DaedalusEngine({
    client,
    cwd: process.cwd(),
    askPermission: (async () => true) as (action: string, target: string) => Promise<boolean>,
    skillDirs: [],
    maxIterations: 5,
  });
  return engine;
}

test('runOnce: returns the final result and usage on success', async () => {
  const client = scriptedClient([
    async function* () {
      yield { type: 'usage', inputTokens: 10, outputTokens: 20 };
      yield doneEvent('the answer is 42');
    },
  ]);
  const engine = await makeEngine(client);
  const res = await runOnce(engine, 'what is 6*7?');
  assert.equal(res.status, 'ok');
  assert.equal(res.result, 'the answer is 42');
  assert.deepEqual(res.usage, { inputTokens: 10, outputTokens: 20 });
  await engine.dispose();
});

test('runOnce: reports status error when the model run fails', async () => {
  const client = scriptedClient([
    async function* () {
      yield { type: 'error', error: { name: 'AiError', message: 'API blew up', kind: 'server' } as never };
    },
  ]);
  const engine = await makeEngine(client);
  const res = await runOnce(engine, 'do a thing');
  assert.equal(res.status, 'error');
  assert.match(res.error ?? '', /API blew up/);
  await engine.dispose();
});
