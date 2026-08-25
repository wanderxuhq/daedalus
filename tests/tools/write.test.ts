import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { writeTool } from '../../src/tools/write.ts';
import { FileUndoRegistry } from '../../src/core/undo.ts';
import { FileLockRegistry } from '../../src/core/file-lock.ts';
import type { ToolContext } from '../../src/tools/types.ts';

function createTestDir(): string {
  return mkdtempSync(join(tmpdir(), 'daedalus-write-test-'));
}

function makeCtx(dir: string, overrides?: Partial<ToolContext>): ToolContext {
  return {
    cwd: dir,
    askPermission: async () => true,
    ...overrides,
  };
}

test('write tool: creates a new file', async () => {
  const dir = createTestDir();
  try {
    const file = join(dir, 'new.txt');
    const result = await writeTool.execute(
      { path: file, content: 'hello world' },
      makeCtx(dir),
    );
    assert.equal(result.isError, undefined);
    assert.equal(readFileSync(file, 'utf8'), 'hello world');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('write tool: creates parent directories', async () => {
  const dir = createTestDir();
  try {
    const file = join(dir, 'deep', 'nested', 'file.txt');
    const result = await writeTool.execute(
      { path: file, content: 'deep content' },
      makeCtx(dir),
    );
    assert.equal(result.isError, undefined);
    assert.equal(readFileSync(file, 'utf8'), 'deep content');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('write tool: overwrites existing file', async () => {
  const dir = createTestDir();
  try {
    const file = join(dir, 'existing.txt');
    writeFileSync(file, 'old content');
    const result = await writeTool.execute(
      { path: file, content: 'new content' },
      makeCtx(dir),
    );
    assert.equal(result.isError, undefined);
    assert.equal(readFileSync(file, 'utf8'), 'new content');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('write tool: uses cwd for relative paths', async () => {
  const dir = createTestDir();
  try {
    const file = join(dir, 'relative.txt');
    const result = await writeTool.execute(
      { path: 'relative.txt', content: 'relative content' },
      makeCtx(dir),
    );
    assert.equal(result.isError, undefined);
    assert.equal(readFileSync(file, 'utf8'), 'relative content');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('write tool: returns unified diff for new file', async () => {
  const dir = createTestDir();
  try {
    const file = join(dir, 'diff-new.txt');
    const result = await writeTool.execute(
      { path: file, content: 'line1\nline2' },
      makeCtx(dir),
    );
    assert.equal(result.isError, undefined);
    assert.ok(result.diff, 'write must return a diff');
    assert.ok(result.diff!.includes('@@ -0,0 +1,2 @@'));
    assert.ok(result.diff!.includes('+line1'));
    assert.ok(result.diff!.includes('+line2'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('write tool: returns unified diff for overwrite', async () => {
  const dir = createTestDir();
  try {
    const file = join(dir, 'diff-overwrite.txt');
    writeFileSync(file, 'old');
    const result = await writeTool.execute(
      { path: file, content: 'new' },
      makeCtx(dir),
    );
    assert.equal(result.isError, undefined);
    assert.ok(result.diff);
    assert.ok(result.diff!.includes('-old'));
    assert.ok(result.diff!.includes('+new'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('write tool: returns error when permission denied', async () => {
  const dir = createTestDir();
  try {
    const file = join(dir, 'denied.txt');
    writeFileSync(file, 'existing');
    const result = await writeTool.execute(
      { path: file, content: 'new' },
      makeCtx(dir, { askPermission: async () => false }),
    );
    assert.equal(result.isError, true);
    assert.ok(result.content.includes('Permission denied'));
    // Original content should be unchanged
    assert.equal(readFileSync(file, 'utf8'), 'existing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('write tool: no permission prompt for new files', async () => {
  const dir = createTestDir();
  try {
    let permissionAsked = false;
    const file = join(dir, 'brand-new.txt');
    const result = await writeTool.execute(
      { path: file, content: 'new' },
      makeCtx(dir, {
        askPermission: async () => { permissionAsked = true; return false; },
      }),
    );
    // Should NOT have asked permission for a new file
    assert.equal(permissionAsked, false);
    assert.equal(result.isError, undefined);
    assert.equal(readFileSync(file, 'utf8'), 'new');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('write tool: snapshots null original for new file (undo deletes)', async () => {
  const dir = createTestDir();
  try {
    const file = join(dir, 'undo-new.txt');
    const undo = new FileUndoRegistry();
    await writeTool.execute(
      { path: file, content: 'created' },
      makeCtx(dir, { undo }),
    );
    assert.equal(undo.size, 1);
    const entry = await undo.undo(undefined);
    assert.equal(entry?.original, null);
    assert.equal(existsSync(file), false); // undo deleted the created file
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('write tool: snapshots original content for overwrite (undo restores)', async () => {
  const dir = createTestDir();
  try {
    const file = join(dir, 'undo-overwrite.txt');
    writeFileSync(file, 'original');
    const undo = new FileUndoRegistry();
    await writeTool.execute(
      { path: file, content: 'overwritten' },
      makeCtx(dir, { undo }),
    );
    assert.equal(undo.size, 1);
    const entry = await undo.undo(undefined);
    assert.equal(entry?.original, 'original');
    assert.equal(readFileSync(file, 'utf8'), 'original');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('write tool: records agent identity in undo', async () => {
  const dir = createTestDir();
  try {
    const file = join(dir, 'agent-undo.txt');
    const undo = new FileUndoRegistry();
    await writeTool.execute(
      { path: file, content: 'content' },
      makeCtx(dir, { undo, agent: 'subagent-2' }),
    );
    const entry = await undo.undo('subagent-2');
    assert.equal(entry?.original, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('write tool: lock conflict returns error', async () => {
  const dir = createTestDir();
  try {
    const file = join(dir, 'locked.txt');
    writeFileSync(file, 'content');
    const locks = new FileLockRegistry(100); // 100ms timeout
    const release = await locks.acquireWrite(file, { holder: 'other-agent' });
    const result = await writeTool.execute(
      { path: file, content: 'new' },
      makeCtx(dir, { locks, agent: 'main' }),
    );
    assert.equal(result.isError, true);
    assert.ok(result.content.includes('timed out'));
    release();
    locks.clear();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('write tool: tool metadata and schema', () => {
  assert.equal(writeTool.name, 'write');
  assert.ok(writeTool.description);
  assert.deepEqual(writeTool.inputSchema, {
    type: 'object',
    properties: {
      path: { type: 'string' },
      content: { type: 'string' },
    },
    required: ['path', 'content'],
  });
});
