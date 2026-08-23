import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileLockRegistry, LockTimeoutError } from '../../src/core/file-lock.ts';
import { createTools } from '../../src/tools/registry.ts';
import { ShellRegistry } from '../../src/tools/shell.ts';
import type { FileLockRegistry as FileLockRegistryType } from '../../src/core/file-lock.ts';
import type { ToolContext } from '../../src/tools/types.ts';

const tools = createTools(new ShellRegistry(process.cwd()));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('readers run concurrently', async () => {
  const reg = new FileLockRegistry();
  const r1 = await reg.acquireRead('/tmp/lock-a.txt');
  const r2 = await reg.acquireRead('/tmp/lock-a.txt'); // must not block
  assert.ok(true);
  r1();
  r2();
  // After release the lock is free again.
  const r3 = await reg.acquireWrite('/tmp/lock-a.txt', { timeoutMs: 100 });
  r3();
});

test('write is exclusive: a second writer times out', async () => {
  const reg = new FileLockRegistry();
  const release = await reg.acquireWrite('/tmp/lock-b.txt');
  await assert.rejects(reg.acquireWrite('/tmp/lock-b.txt', { timeoutMs: 50 }), /timed out/);
  release();
  const w = await reg.acquireWrite('/tmp/lock-b.txt', { timeoutMs: 100 });
  w();
});

test('writer blocks readers until released, then queued reader proceeds', async () => {
  const reg = new FileLockRegistry();
  const release = await reg.acquireWrite('/tmp/lock-c.txt');
  await assert.rejects(reg.acquireRead('/tmp/lock-c.txt', { timeoutMs: 50 }), /timed out/);
  release();
  const r = await reg.acquireRead('/tmp/lock-c.txt', { timeoutMs: 200 });
  r();
});

test('writer-preferring: a queued writer blocks LATER readers (no starvation)', async () => {
  const reg = new FileLockRegistry();
  const releaseRead = await reg.acquireRead('/tmp/lock-d.txt');
  let writerDone = false;
  const writer = reg.acquireWrite('/tmp/lock-d.txt', { timeoutMs: 500 }).then((rel) => { writerDone = true; return rel; });
  await sleep(20); // let the writer queue behind the active reader
  // A reader requested AFTER the writer queued must wait behind the writer…
  await assert.rejects(reg.acquireRead('/tmp/lock-d.txt', { timeoutMs: 50 }), /timed out/);
  releaseRead(); // …now the writer takes over
  const releaseWrite = await writer;
  assert.equal(writerDone, true);
  releaseWrite(); // writer releases before the final read
  const r = await reg.acquireRead('/tmp/lock-d.txt', { timeoutMs: 200 });
  r();
});

test('timeout error names the current holder for arbitration', async () => {
  const reg = new FileLockRegistry();
  const release = await reg.acquireWrite('/tmp/lock-e.txt', { holder: 'workerB' });
  const err = await reg.acquireWrite('/tmp/lock-e.txt', { holder: 'workerA', timeoutMs: 30 })
    .then(() => { throw new Error('expected rejection'); })
    .catch((e) => e);
  assert.ok(err instanceof LockTimeoutError);
  assert.match(err.message, /lock-e\.txt/);
  assert.match(err.message, /workerB/);
  release();
});

test('paths are normalized: a/../b and b share one lock', async () => {
  const reg = new FileLockRegistry();
  const w1 = await reg.acquireWrite('/tmp/dir/../lock-f.txt');
  await assert.rejects(reg.acquireWrite('/tmp/lock-f.txt', { timeoutMs: 50 }), /timed out/);
  w1();
});

// --- tool wiring: read/write/edit take the right lock kind and always release ---

/** A lock registry spy that records acquire calls and active-holder depth. */
function spyLocks() {
  const calls: Array<{ kind: 'read' | 'write'; path: string; holder?: string }> = [];
  let active = 0;
  const registry = {
    acquireRead: async (path: string, o?: { holder?: string }) => {
      calls.push({ kind: 'read', path, holder: o?.holder });
      active++;
      return () => { active--; };
    },
    acquireWrite: async (path: string, o?: { holder?: string }) => {
      calls.push({ kind: 'write', path, holder: o?.holder });
      active++;
      return () => { active--; };
    },
  } as unknown as FileLockRegistryType;
  return { calls, registry, active: () => active };
}

const dir = join(tmpdir(), `dae-lock-tool-${Date.now()}`);
mkdirSync(dir, { recursive: true });

test('read tool takes a READ lock tagged with the agent name', async () => {
  const file = join(dir, 'r.txt');
  writeFileSync(file, 'hello');
  const { calls, registry, active } = spyLocks();
  const readTool = tools.find((t) => t.name === 'read')!;
  const res = await readTool.execute({ path: file }, { cwd: dir, askPermission: async () => true, locks: registry, agent: 'workerA' } as ToolContext);
  assert.equal(res.isError, undefined);
  assert.deepEqual(calls, [{ kind: 'read', path: file, holder: 'workerA' }]);
  assert.equal(active(), 0); // released after the read
});

test('write tool takes a WRITE lock and releases it', async () => {
  const file = join(dir, 'w.txt');
  const { calls, registry, active } = spyLocks();
  const writeTool = tools.find((t) => t.name === 'write')!;
  await writeTool.execute({ path: file, content: 'x' }, { cwd: dir, askPermission: async () => true, locks: registry, agent: 'main' } as ToolContext);
  assert.deepEqual(calls, [{ kind: 'write', path: file, holder: 'main' }]);
  assert.equal(active(), 0);
});

test('edit tool holds a WRITE lock across its read-modify-write and releases on error', async () => {
  const file = join(dir, 'e.txt');
  writeFileSync(file, 'foo bar');
  const { calls, registry, active } = spyLocks();
  const editTool = tools.find((t) => t.name === 'edit')!;
  await editTool.execute({ path: file, oldString: 'bar', newString: 'BAZ' }, { cwd: dir, askPermission: async () => true, locks: registry } as ToolContext);
  assert.deepEqual(calls, [{ kind: 'write', path: file, holder: 'main' }]);
  assert.equal(active(), 0);
  // Error path (oldString not found) must also release.
  await editTool.execute({ path: file, oldString: 'nope', newString: 'x' }, { cwd: dir, askPermission: async () => true, locks: registry } as ToolContext);
  assert.equal(calls.length, 2);
  assert.equal(active(), 0);
});

test('write tool reports a lock conflict as an error result naming the holder', async () => {
  const file = join(dir, 'c.txt');
  const reg = new FileLockRegistry(50);
  const hold = await reg.acquireWrite(file, { holder: 'workerB' });
  const writeTool = tools.find((t) => t.name === 'write')!;
  const res = await writeTool.execute({ path: file, content: 'x' }, { cwd: dir, askPermission: async () => true, locks: reg, agent: 'workerA' } as ToolContext);
  assert.equal(res.isError, true);
  assert.match(res.content, /timed out/);
  assert.match(res.content, /workerB/);
  hold();
  // After the holder releases, the same write succeeds.
  const ok = await writeTool.execute({ path: file, content: 'y' }, { cwd: dir, askPermission: async () => true, locks: reg, agent: 'workerA' } as ToolContext);
  assert.equal(ok.isError, undefined);
});

test('tools degrade gracefully when no lock registry is present', async () => {
  const file = join(dir, 'g.txt');
  const writeTool = tools.find((t) => t.name === 'write')!;
  const readTool = tools.find((t) => t.name === 'read')!;
  await writeTool.execute({ path: file, content: 'ok' }, { cwd: dir, askPermission: async () => true } as ToolContext);
  const r = await readTool.execute({ path: file }, { cwd: dir, askPermission: async () => true } as ToolContext);
  assert.equal(r.content, 'ok');
});

test('cleanup tmp dir', () => {
  rmSync(dir, { recursive: true, force: true });
});
