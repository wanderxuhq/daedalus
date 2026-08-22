import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chat, deleteSession } from './api.ts';

test('chat returns ok on 200', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ status: 'ok', result: 'r' }), { status: 200, headers: { 'Content-Type': 'application/json' } }) as any;
  const res = await chat('hi');
  assert.deepEqual(res, { status: 'ok', result: 'r' });
});

test('deleteSession POSTs the id and resolves', async () => {
  let body: string | undefined;
  globalThis.fetch = async (_url: any, init: any) => {
    body = init.body;
    return new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } }) as any;
  };
  await deleteSession('s1');
  assert.equal(body, JSON.stringify({ id: 's1' }));
});
