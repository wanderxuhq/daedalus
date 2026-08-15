import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../../src/core/session-store.ts';
import type { SessionState } from '../../src/core/session.ts';

const state: SessionState = {
  messages: [
    { role: 'system', content: [{ type: 'text', text: 'sys' }] },
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
  ],
  loadedSkills: ['review'],
};

function tmpStore(): { store: SessionStore; dir: string } {
  const dir = join(tmpdir(), `dae-store-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return { store: new SessionStore(dir), dir };
}

test('save writes a JSON file and load round-trips state', async () => {
  const { store, dir } = tmpStore();
  const id = await store.save(state);
  assert.ok(id.length > 0);
  assert.ok(existsSync(join(dir, `${id}.json`)));
  const loaded = await store.load(id);
  assert.deepEqual(loaded.messages, state.messages);
  assert.deepEqual(loaded.loadedSkills, state.loadedSkills);
  assert.equal(loaded.id, id);
  assert.ok(loaded.createdAt);
  assert.ok(loaded.updatedAt);
  rmSync(dir, { recursive: true, force: true });
});

test('save reuses a provided id and preserves createdAt across updates', async () => {
  const { store } = tmpStore();
  await store.save(state, { id: 'fixed' });
  const first = await store.load('fixed');
  await new Promise((r) => setTimeout(r, 5));
  const second = await store.save({
    messages: [...state.messages, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }],
    loadedSkills: ['review'],
  }, { id: 'fixed' });
  assert.equal(second, 'fixed');
  const loaded = await store.load('fixed');
  assert.equal(loaded.createdAt, first.createdAt);
  assert.ok(loaded.updatedAt >= first.updatedAt);
  assert.equal(loaded.messages.length, 3);
});

test('list returns metadata sorted by updatedAt desc, without full messages', async () => {
  const { store } = tmpStore();
  await store.save(state, { id: 'older' });
  await new Promise((r) => setTimeout(r, 5));
  await store.save(state, { id: 'newer' });
  const list = await store.list();
  assert.equal(list.length, 2);
  assert.equal(list[0].id, 'newer');
  assert.equal(list[1].id, 'older');
  assert.equal(list[0].messageCount, 2);
  assert.ok(!('messages' in list[0]));
});

test('latest returns the most recently updated session', async () => {
  const { store } = tmpStore();
  await store.save(state, { id: 'a' });
  await new Promise((r) => setTimeout(r, 5));
  await store.save(state, { id: 'b' });
  const latest = await store.latest();
  assert.equal(latest!.id, 'b');
});

test('remove deletes the file', async () => {
  const { store, dir } = tmpStore();
  await store.save(state, { id: 'gone' });
  await store.remove('gone');
  assert.ok(!existsSync(join(dir, 'gone.json')));
});

test('a leftover .tmp file is ignored and does not corrupt the store', async () => {
  const { store, dir } = tmpStore();
  await store.save(state, { id: 'real' });
  writeFileSync(join(dir, 'real.json.tmp'), 'not valid json');
  const list = await store.list();
  assert.equal(list.length, 1);
  const loaded = await store.load('real');
  assert.equal(loaded.messages.length, 2);
});

test('load throws on corrupt JSON and on a missing id', async () => {
  const { store, dir } = tmpStore();
  writeFileSync(join(dir, 'corrupt.json'), '{nope');
  await assert.rejects(() => store.load('corrupt'), /Corrupt/);
  await assert.rejects(() => store.load('missing'), /not found/);
});

test('load throws when the file has no messages or loadedSkills arrays', async () => {
  const { store, dir } = tmpStore();
  writeFileSync(join(dir, 'shape.json'), JSON.stringify({ id: 'shape' }));
  await assert.rejects(() => store.load('shape'), /Corrupt/);
});

test('save rejects when the existing file is corrupt instead of silently overwriting', async () => {
  const { store, dir } = tmpStore();
  writeFileSync(join(dir, 'corrupt.json'), '{nope');
  await assert.rejects(() => store.save(state, { id: 'corrupt' }), /Corrupt/);
});
