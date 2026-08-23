import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FileUndoRegistry } from '../../src/core/undo.ts';
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function tmp(): string {
  const dir = join(tmpdir(), `dae-undo-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test('undo restores the pre-mutation content (LIFO)', async () => {
  const dir = tmp();
  const f = join(dir, 'a.txt');
  const reg = new FileUndoRegistry();
  writeFileSync(f, 'v1');
  reg.record(undefined, f, 'v1');
  writeFileSync(f, 'v2');
  reg.record(undefined, f, 'v2');
  writeFileSync(f, 'v3');

  const first = await reg.undo(undefined);
  assert.equal(first?.original, 'v2');
  assert.equal(readFileSync(f, 'utf8'), 'v2');

  const second = await reg.undo(undefined);
  assert.equal(second?.original, 'v1');
  assert.equal(readFileSync(f, 'utf8'), 'v1');

  assert.equal(await reg.undo(undefined), undefined); // stack empty
  rmSync(dir, { recursive: true, force: true });
});

test('undo of a file the mutation created deletes it', async () => {
  const dir = tmp();
  const f = join(dir, 'new.txt');
  const reg = new FileUndoRegistry();
  reg.record(undefined, f, null); // created: no prior content
  writeFileSync(f, 'created');

  const entry = await reg.undo(undefined);
  assert.equal(entry?.original, null);
  assert.equal(existsSync(f), false);
  rmSync(dir, { recursive: true, force: true });
});

test('per-agent stacks are isolated (subagent edits are not undone by /undo)', async () => {
  const dir = tmp();
  const f = join(dir, 'a.txt');
  const reg = new FileUndoRegistry();
  writeFileSync(f, 'v1');
  reg.record(undefined, f, 'v1'); // main's snapshot (before main edits)
  writeFileSync(f, 'v2');
  reg.record('explorer', f, 'v2'); // subagent's snapshot (before the sub edits)
  writeFileSync(f, 'v3');

  // The subagent undoes ITS OWN latest write: back to v2…
  const sub = await reg.undo('explorer');
  assert.equal(sub?.original, 'v2');
  assert.equal(readFileSync(f, 'utf8'), 'v2');
  // …and the main stack is untouched: /undo (main) pops main's own snapshot.
  const main = await reg.undo('main');
  assert.equal(main?.original, 'v1');
  assert.equal(readFileSync(f, 'utf8'), 'v1');
  rmSync(dir, { recursive: true, force: true });
});

test('capacity cap drops the oldest snapshots', async () => {
  const dir = tmp();
  const f = join(dir, 'c.txt');
  const reg = new FileUndoRegistry(2);
  reg.record(undefined, f, '1');
  reg.record(undefined, f, '2');
  reg.record(undefined, f, '3');
  assert.equal(reg.size, 2); // '1' fell off

  const e1 = await reg.undo(undefined);
  assert.equal(e1?.original, '3');
  assert.equal(readFileSync(f, 'utf8'), '3');
  const e2 = await reg.undo(undefined);
  assert.equal(e2?.original, '2');
  assert.equal(readFileSync(f, 'utf8'), '2');
  assert.equal(await reg.undo(undefined), undefined);
  rmSync(dir, { recursive: true, force: true });
});

test('clear drops every stack', () => {
  const reg = new FileUndoRegistry();
  reg.record(undefined, '/x', '1');
  reg.record('sub', '/y', '2');
  assert.equal(reg.size, 2);
  reg.clear();
  assert.equal(reg.size, 0);
});
