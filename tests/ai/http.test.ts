import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { HttpClient } from '../../src/ai/http.ts';
import { AiError } from '../../src/ai/errors.ts';

test('throws auth AiError on 401', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = mock.fn(async () =>
    new Response('{"error":{"message":"bad key"}}', { status: 401 })) as typeof fetch;
  const client = new HttpClient({ baseURL: 'https://x', apiKey: 'k' });
  await assert.rejects(() => client.stream('/chat', {}), (e: unknown) => {
    assert.ok(e instanceof AiError);
    assert.equal((e as AiError).kind, 'auth');
    return true;
  });
  globalThis.fetch = origFetch;
});

test('retries on 429 then succeeds', async () => {
  const origFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = mock.fn(async () => {
    calls++;
    if (calls === 1) return new Response('', { status: 429 });
    return new Response('ok');
  }) as typeof fetch;
  const client = new HttpClient({ baseURL: 'https://x', apiKey: 'k', maxRetries: 2, timeoutMs: 1000 });
  const stream = await client.stream('/chat', {});
  const text = await new Response(stream).text();
  assert.equal(text, 'ok');
  assert.equal(calls, 2);
  globalThis.fetch = origFetch;
});

test('gives up after maxRetries on persistent 5xx', async () => {
  const origFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = mock.fn(async () => { calls++; return new Response('', { status: 500 }); }) as typeof fetch;
  const client = new HttpClient({ baseURL: 'https://x', apiKey: 'k', maxRetries: 2 });
  await assert.rejects(() => client.stream('/chat', {}), (e: unknown) => {
    assert.equal((e as AiError).kind, 'server');
    return true;
  });
  assert.equal(calls, 3); // initial + 2 retries
  globalThis.fetch = origFetch;
});
