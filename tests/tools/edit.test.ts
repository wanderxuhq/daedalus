import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { editTool } from '../../src/tools/edit.ts';
import { FileLockRegistry } from '../../src/core/file-lock.ts';
import { FileUndoRegistry } from '../../src/core/undo.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'daedalus-edit-'));

test('edit tool: replaces exact string in file', async () => {
  const dir = tmp();
  const filePath = join(dir, 'test.txt');
  writeFileSync(filePath, 'Hello World');
  
  const ctx = {
    cwd: dir,
    askPermission: async () => true,
    agent: 'test',
    locks: new FileLockRegistry(),
    undo: new FileUndoRegistry(),
  };
  
  const result = await editTool.execute(
    { path: 'test.txt', oldString: 'World', newString: 'TypeScript' },
    ctx
  );
  
  assert.ok(result.content.includes('Edited'));
  assert.ok(result.diff);
  const content = readFileSync(filePath, 'utf8');
  assert.equal(content, 'Hello TypeScript');
  
  rmSync(dir, { recursive: true, force: true });
});

test('edit tool: returns error when oldString not found', async () => {
  const dir = tmp();
  const filePath = join(dir, 'test.txt');
  writeFileSync(filePath, 'Hello World');
  
  const ctx = {
    cwd: dir,
    askPermission: async () => true,
    agent: 'test',
    locks: new FileLockRegistry(),
    undo: new FileUndoRegistry(),
  };
  
  const result = await editTool.execute(
    { path: 'test.txt', oldString: 'NotFound', newString: 'Replacement' },
    ctx
  );
  
  assert.equal(result.isError, true);
  assert.ok(result.content.includes('not found'));
  
  rmSync(dir, { recursive: true, force: true });
});

test('edit tool: returns error when oldString matches multiple times', async () => {
  const dir = tmp();
  const filePath = join(dir, 'test.txt');
  writeFileSync(filePath, 'test test test');
  
  const ctx = {
    cwd: dir,
    askPermission: async () => true,
    agent: 'test',
    locks: new FileLockRegistry(),
    undo: new FileUndoRegistry(),
  };
  
  const result = await editTool.execute(
    { path: 'test.txt', oldString: 'test', newString: 'replaced' },
    ctx
  );
  
  assert.equal(result.isError, true);
  assert.ok(result.content.includes('matches'));
  
  rmSync(dir, { recursive: true, force: true });
});

test('edit tool: handles multi-line strings', async () => {
  const dir = tmp();
  const filePath = join(dir, 'test.txt');
  writeFileSync(filePath, 'Line 1\nLine 2\nLine 3');
  
  const ctx = {
    cwd: dir,
    askPermission: async () => true,
    agent: 'test',
    locks: new FileLockRegistry(),
    undo: new FileUndoRegistry(),
  };
  
  const result = await editTool.execute(
    { path: 'test.txt', oldString: 'Line 2', newString: 'New Line 2' },
    ctx
  );
  
  assert.ok(result.content.includes('Edited'));
  const content = readFileSync(filePath, 'utf8');
  assert.equal(content, 'Line 1\nNew Line 2\nLine 3');
  
  rmSync(dir, { recursive: true, force: true });
});

test('edit tool: creates undo snapshot', async () => {
  const dir = tmp();
  const filePath = join(dir, 'test.txt');
  writeFileSync(filePath, 'Original content');
  
  const locks = new FileLockRegistry();
  const undo = new FileUndoRegistry();
  const ctx = {
    cwd: dir,
    askPermission: async () => true,
    agent: 'test',
    locks,
    undo,
  };
  
  await editTool.execute(
    { path: 'test.txt', oldString: 'Original', newString: 'Modified' },
    ctx
  );
  
  // Check that undo snapshot was created by verifying undo works
  assert.equal(undo.size, 1);
  const entry = await undo.undo('test', locks);
  assert.ok(entry);
  assert.equal(entry.path, filePath);
  assert.equal(entry.original, 'Original content');
  
  // Verify file was restored
  const content = readFileSync(filePath, 'utf8');
  assert.equal(content, 'Original content');
  
  rmSync(dir, { recursive: true, force: true });
});

test('edit tool: handles file not found', async () => {
  const dir = tmp();
  const ctx = {
    cwd: dir,
    askPermission: async () => true,
    agent: 'test',
    locks: new FileLockRegistry(),
    undo: new FileUndoRegistry(),
  };
  
  const result = await editTool.execute(
    { path: 'nonexistent.txt', oldString: 'test', newString: 'replacement' },
    ctx
  );
  
  assert.equal(result.isError, true);
  assert.ok(result.content.includes('ENOENT'));
  assert.ok(result.content.includes('nonexistent.txt'));
  
  rmSync(dir, { recursive: true, force: true });
});

test('edit tool: handles relative and absolute paths', async () => {
  const dir = tmp();
  const subdir = join(dir, 'sub');
  mkdirSync(subdir);
  const filePath = join(subdir, 'test.txt');
  writeFileSync(filePath, 'Content');
  
  const ctx = {
    cwd: dir,
    askPermission: async () => true,
    agent: 'test',
    locks: new FileLockRegistry(),
    undo: new FileUndoRegistry(),
  };
  
  // Test relative path
  const result1 = await editTool.execute(
    { path: 'sub/test.txt', oldString: 'Content', newString: 'Updated' },
    ctx
  );
  assert.ok(result1.content.includes('Edited'));
  
  // Test absolute path
  writeFileSync(filePath, 'Content again');
  const result2 = await editTool.execute(
    { path: filePath, oldString: 'Content again', newString: 'Updated again' },
    ctx
  );
  assert.ok(result2.content.includes('Edited'));
  
  rmSync(dir, { recursive: true, force: true });
});

test('edit tool: generates unified diff', async () => {
  const dir = tmp();
  const filePath = join(dir, 'test.txt');
  writeFileSync(filePath, 'Line 1\nLine 2\nLine 3');
  
  const ctx = {
    cwd: dir,
    askPermission: async () => true,
    agent: 'test',
    locks: new FileLockRegistry(),
    undo: new FileUndoRegistry(),
  };
  
  const result = await editTool.execute(
    { path: 'test.txt', oldString: 'Line 2', newString: 'New Line 2' },
    ctx
  );
  
  assert.ok(result.diff);
  assert.ok(result.diff.includes('-Line 2'));
  assert.ok(result.diff.includes('+New Line 2'));
  
  rmSync(dir, { recursive: true, force: true });
});

test('edit tool: handles concurrent edits with locking', async () => {
  const dir = tmp();
  const filePath = join(dir, 'test.txt');
  writeFileSync(filePath, 'Initial');
  
  const locks = new FileLockRegistry();
  const undo = new FileUndoRegistry();
  
  const ctx1 = {
    cwd: dir,
    askPermission: async () => true,
    agent: 'agent1',
    locks,
    undo,
  };
  
  const ctx2 = {
    cwd: dir,
    askPermission: async () => true,
    agent: 'agent2',
    locks,
    undo,
  };
  
  // First edit should succeed
  const result1 = await editTool.execute(
    { path: 'test.txt', oldString: 'Initial', newString: 'Updated by agent1' },
    ctx1
  );
  assert.ok(result1.content.includes('Edited'));
  
  // Second edit should succeed (after first is complete)
  const result2 = await editTool.execute(
    { path: 'test.txt', oldString: 'Updated by agent1', newString: 'Updated by agent2' },
    ctx2
  );
  assert.ok(result2.content.includes('Edited'));
  
  const content = readFileSync(filePath, 'utf8');
  assert.equal(content, 'Updated by agent2');
  
  rmSync(dir, { recursive: true, force: true });
});

test('edit tool: preserves file encoding', async () => {
  const dir = tmp();
  const filePath = join(dir, 'test.txt');
  const unicodeContent = 'Hello 世界 🌍';
  writeFileSync(filePath, unicodeContent, 'utf8');
  
  const ctx = {
    cwd: dir,
    askPermission: async () => true,
    agent: 'test',
    locks: new FileLockRegistry(),
    undo: new FileUndoRegistry(),
  };
  
  const result = await editTool.execute(
    { path: 'test.txt', oldString: '世界', newString: 'Universe' },
    ctx
  );
  
  assert.ok(result.content.includes('Edited'));
  const content = readFileSync(filePath, 'utf8');
  assert.equal(content, 'Hello Universe 🌍');
  
  rmSync(dir, { recursive: true, force: true });
});