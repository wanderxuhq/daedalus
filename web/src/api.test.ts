import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chat } from './api.ts';

test('chat returns ok on 200', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ status: 'ok', result: 'r' }), { status: 200, headers: { 'Content-Type': 'application/json' } }) as any;
  const res = await chat('hi');
  assert.deepEqual(res, { status: 'ok', result: 'r' });
});
