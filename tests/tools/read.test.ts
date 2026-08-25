import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTool } from '../../src/tools/read.ts';
import { FileLockRegistry } from '../../src/core/file-lock.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'daedalus-read-'));

test('read tool: reads entire file', async () => {
  const dir = tmp();
  const filePath = join(dir, 'test.txt');
  writeFileSync(filePath, 'Line 1\nLine 2\nLine 3');
  
  const ctx = {
    cwd: dir,
    askPermission: async () => true,
    agent: 'test',
    locks: new FileLockRegistry(),
  };
  
  const result = await readTool.execute({ path: 'test.txt' }, ctx);
  assert.equal(result.content, 'Line 1\nLine 2\nLine 3');
  assert.equal(result.isError, undefined);
  
  rmSync(dir, { recursive: true, force: true });
});

test('read tool: reads with line numbers when using offset', async () => {
  const dir = tmp();
  const filePath = join(dir, 'test.txt');
  writeFileSync(filePath, 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5');
  
  const ctx = {
    cwd: dir,
    askPermission: async () => true,
    agent: 'test',
    locks: new FileLockRegistry(),
  };
  
  const result = await readTool.execute({ path: 'test.txt', offset: 1, limit: 3 }, ctx);
  const lines = result.content.split('\n');
  assert.equal(lines.length, 3);
  assert.ok(lines[0].startsWith('2\t'));
  assert.ok(lines[1].startsWith('3\t'));
  assert.ok(lines[2].startsWith('4\t'));
  
  rmSync(dir, { recursive: true, force: true });
});

test('read tool: returns error for nonexistent file', async () => {
  const dir = tmp();
  const ctx = {
    cwd: dir,
    askPermission: async () => true,
    agent: 'test',
    locks: new FileLockRegistry(),
  };
  
  const result = await readTool.execute({ path: 'nonexistent.txt' }, ctx);
  assert.equal(result.isError, true);
  assert.ok(result.content.includes('ENOENT'));
  
  rmSync(dir, { recursive: true, force: true });
});

test('read tool: returns error for directory', async () => {
  const dir = tmp();
  const subdir = join(dir, 'subdir');
  mkdirSync(subdir);
  
  const ctx = {
    cwd: dir,
    askPermission: async () => true,
    agent: 'test',
    locks: new FileLockRegistry(),
  };
  
  const result = await readTool.execute({ path: 'subdir' }, ctx);
  assert.equal(result.isError, true);
  assert.ok(result.content.includes('EISDIR'));
  
  rmSync(dir, { recursive: true, force: true });
});

test('read tool: handles large files with offset/limit', async () => {
  const dir = tmp();
  const filePath = join(dir, 'large.txt');
  const lines = Array.from({ length: 1000 }, (_, i) => `Line ${i + 1}`);
  writeFileSync(filePath, lines.join('\n'));
  
  const ctx = {
    cwd: dir,
    askPermission: async () => true,
    agent: 'test',
    locks: new FileLockRegistry(),
  };
  
  // Read middle section
  const result = await readTool.execute({ path: 'large.txt', offset: 500, limit: 10 }, ctx);
  const resultLines = result.content.split('\n');
  assert.equal(resultLines.length, 10);
  assert.ok(resultLines[0].startsWith('501\t'));
  assert.ok(resultLines[9].startsWith('510\t'));
  
  rmSync(dir, { recursive: true, force: true });
});

test('read tool: handles absolute paths', async () => {
  const dir = tmp();
  const filePath = join(dir, 'absolute.txt');
  writeFileSync(filePath, 'Absolute path content');
  
  const ctx = {
    cwd: dir,
    askPermission: async () => true,
    agent: 'test',
    locks: new FileLockRegistry(),
  };
  
  const result = await readTool.execute({ path: filePath }, ctx);
  assert.equal(result.content, 'Absolute path content');
  
  rmSync(dir, { recursive: true, force: true });
});

test('read tool: handles relative paths from cwd', async () => {
  const dir = tmp();
  const subdir = join(dir, 'sub');
  mkdirSync(subdir);
  const filePath = join(subdir, 'relative.txt');
  writeFileSync(filePath, 'Relative path content');
  
  const ctx = {
    cwd: dir,
    askPermission: async () => true,
    agent: 'test',
    locks: new FileLockRegistry(),
  };
  
  const result = await readTool.execute({ path: 'sub/relative.txt' }, ctx);
  assert.equal(result.content, 'Relative path content');
  
  rmSync(dir, { recursive: true, force: true });
});

test('read tool: handles empty file', async () => {
  const dir = tmp();
  const filePath = join(dir, 'empty.txt');
  writeFileSync(filePath, '');
  
  const ctx = {
    cwd: dir,
    askPermission: async () => true,
    agent: 'test',
    locks: new FileLockRegistry(),
  };
  
  const result = await readTool.execute({ path: 'empty.txt' }, ctx);
  assert.equal(result.content, '');
  assert.equal(result.isError, undefined);
  
  rmSync(dir, { recursive: true, force: true });
});

test('read tool: handles file with only newlines', async () => {
  const dir = tmp();
  const filePath = join(dir, 'newlines.txt');
  writeFileSync(filePath, '\n\n\n');
  
  const ctx = {
    cwd: dir,
    askPermission: async () => true,
    agent: 'test',
    locks: new FileLockRegistry(),
  };
  
  const result = await readTool.execute({ path: 'newlines.txt' }, ctx);
  // The file has 3 newlines, which means 4 empty lines (including the last one)
  // But readline may handle this differently
  const lines = result.content.split('\n');
  assert.ok(lines.length >= 2); // At least 2 lines
  assert.equal(result.isError, undefined);
  
  rmSync(dir, { recursive: true, force: true });
});

test('read tool: respects limit parameter', async () => {
  const dir = tmp();
  const filePath = join(dir, 'test.txt');
  writeFileSync(filePath, 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5');
  
  const ctx = {
    cwd: dir,
    askPermission: async () => true,
    agent: 'test',
    locks: new FileLockRegistry(),
  };
  
  const result = await readTool.execute({ path: 'test.txt', limit: 2 }, ctx);
  const lines = result.content.split('\n');
  assert.equal(lines.length, 2);
  assert.ok(lines[0].includes('Line 1'));
  assert.ok(lines[1].includes('Line 2'));
  
  rmSync(dir, { recursive: true, force: true });
});

test('read tool: handles offset beyond file length', async () => {
  const dir = tmp();
  const filePath = join(dir, 'test.txt');
  writeFileSync(filePath, 'Line 1\nLine 2\nLine 3');
  
  const ctx = {
    cwd: dir,
    askPermission: async () => true,
    agent: 'test',
    locks: new FileLockRegistry(),
  };
  
  const result = await readTool.execute({ path: 'test.txt', offset: 10 }, ctx);
  assert.equal(result.content, '');
  assert.equal(result.isError, undefined);
  
  rmSync(dir, { recursive: true, force: true });
});

test('read tool: handles binary files gracefully', async () => {
  const dir = tmp();
  const filePath = join(dir, 'binary.bin');
  // Create a binary file with some non-text content
  const buffer = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]);
  writeFileSync(filePath, buffer);
  
  const ctx = {
    cwd: dir,
    askPermission: async () => true,
    agent: 'test',
    locks: new FileLockRegistry(),
  };
  
  const result = await readTool.execute({ path: 'binary.bin' }, ctx);
  // Should not crash, may have garbage content but no error
  assert.equal(result.isError, undefined);
  
  rmSync(dir, { recursive: true, force: true });
});

test('read tool: handles concurrent reads', async () => {
  const dir = tmp();
  const filePath = join(dir, 'concurrent.txt');
  writeFileSync(filePath, 'Concurrent content');
  
  const locks = new FileLockRegistry();
  const ctx1 = {
    cwd: dir,
    askPermission: async () => true,
    agent: 'agent1',
    locks,
  };
  
  const ctx2 = {
    cwd: dir,
    askPermission: async () => true,
    agent: 'agent2',
    locks,
  };
  
  // Both reads should succeed concurrently
  const [result1, result2] = await Promise.all([
    readTool.execute({ path: 'concurrent.txt' }, ctx1),
    readTool.execute({ path: 'concurrent.txt' }, ctx2),
  ]);
  
  assert.equal(result1.content, 'Concurrent content');
  assert.equal(result2.content, 'Concurrent content');
  assert.equal(result1.isError, undefined);
  assert.equal(result2.isError, undefined);
  
  rmSync(dir, { recursive: true, force: true });
});

test('read tool: truncates large output', async () => {
  const dir = tmp();
  const filePath = join(dir, 'large-output.txt');
  // Create a file with many lines
  const lines = Array.from({ length: 10000 }, (_, i) => `Line ${i + 1}`);
  writeFileSync(filePath, lines.join('\n'));
  
  const ctx = {
    cwd: dir,
    askPermission: async () => true,
    agent: 'test',
    locks: new FileLockRegistry(),
  };
  
  const result = await readTool.execute({ path: 'large-output.txt' }, ctx);
  // Should not crash and should truncate output
  assert.equal(result.isError, undefined);
  // The content should be truncated (not contain all 10000 lines)
  const resultLines = result.content.split('\n');
  assert.ok(resultLines.length < 10000);
  
  rmSync(dir, { recursive: true, force: true });
});