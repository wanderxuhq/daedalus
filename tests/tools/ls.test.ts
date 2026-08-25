import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { lsTool } from '../../src/tools/ls.ts';

// Helper to create a temporary directory with test files
function createTestDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'daedalus-ls-test-'));
  writeFileSync(join(dir, 'file1.txt'), 'content1');
  writeFileSync(join(dir, 'file2.txt'), 'content2');
  mkdirSync(join(dir, 'subdir'));
  writeFileSync(join(dir, 'subdir', 'nested.txt'), 'nested content');
  // Create node_modules and .git to test ignore behavior
  mkdirSync(join(dir, 'node_modules'));
  writeFileSync(join(dir, 'node_modules', 'ignored.txt'), 'ignored');
  mkdirSync(join(dir, '.git'));
  writeFileSync(join(dir, '.git', 'ignored'), 'ignored');
  return dir;
}

// Helper to create ToolContext
function makeCtx(cwd: string) {
  return {
    cwd,
    askPermission: async () => true,
  };
}

test('ls lists directory contents', async () => {
  const dir = createTestDir();
  try {
    const ctx = makeCtx(dir);
    const result = await lsTool.execute({}, ctx);
    
    assert.equal(result.isError, undefined);
    assert.ok(result.content.includes('file1.txt'));
    assert.ok(result.content.includes('file2.txt'));
    assert.ok(result.content.includes('subdir/'));
    // Should not include node_modules or .git
    assert.ok(!result.content.includes('node_modules'));
    assert.ok(!result.content.includes('.git'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ls lists specific path', async () => {
  const dir = createTestDir();
  try {
    const ctx = makeCtx(dir);
    const result = await lsTool.execute({ path: 'subdir' }, ctx);
    
    assert.equal(result.isError, undefined);
    assert.ok(result.content.includes('nested.txt'));
    assert.ok(!result.content.includes('file1.txt'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ls handles empty directory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'daedalus-ls-empty-'));
  try {
    const ctx = makeCtx(dir);
    const result = await lsTool.execute({}, ctx);
    
    assert.equal(result.isError, undefined);
    assert.ok(result.content.includes('(empty)'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ls handles non-existent path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'daedalus-ls-nonexist-'));
  try {
    const ctx = makeCtx(dir);
    const result = await lsTool.execute({ path: 'nonexistent' }, ctx);
    
    // Should return error for non-existent path
    assert.equal(result.isError, true);
    assert.ok(result.content.includes('ENOENT') || result.content.includes('no such file'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ls handles absolute path', async () => {
  const dir = createTestDir();
  try {
    const ctx = makeCtx('/tmp'); // context cwd is different
    const result = await lsTool.execute({ path: dir }, ctx);
    
    assert.equal(result.isError, undefined);
    assert.ok(result.content.includes('file1.txt'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ls shows hidden files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'daedalus-ls-hidden-'));
  try {
    writeFileSync(join(dir, '.hidden'), 'hidden content');
    writeFileSync(join(dir, 'visible.txt'), 'visible');
    
    const ctx = makeCtx(dir);
    const result = await lsTool.execute({}, ctx);
    
    assert.equal(result.isError, undefined);
    assert.ok(result.content.includes('.hidden')); // Should show hidden files
    assert.ok(result.content.includes('visible.txt'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});