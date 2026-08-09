import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAiClient, type AiProviderName } from '../../src/ai/index.ts';

test('factory returns a client for known providers', () => {
  const client = createAiClient({ provider: 'anthropic', apiKey: 'k' });
  assert.equal(typeof client.streamChat, 'function');
});

test('factory throws for unknown provider', () => {
  assert.throws(() => createAiClient({ provider: 'bogus' as AiProviderName, apiKey: 'k' }));
});
