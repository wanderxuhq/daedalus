import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { grepTool } from '../../src/tools/grep.ts';
import type { ToolContext } from '../../src/tools/types.ts';

function createTestDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'daedalus-grep-test-'));
  writeFileSync(join(dir, 'a.txt'), 'hello world\nfoo bar\nhello again');
  writeFileSync(join(dir, 'b.txt'), 'no match here\nanother line');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'index.ts'), 'import { grepTool } from "./grep";\nexport const x = 1;');
  writeFileSync(join(dir, '.gitignore'), 'build/\n*.log');
  mkdirSync(join(dir, 'build'));
  writeFileSync(join(dir, 'build', 'output.js'), 'should be ignored');
  writeFileSync(join(dir, 'app.log'), 'log entry with needle\n');
  // Create ignored directories
  mkdirSync(join(dir, 'node_modules'));
  writeFileSync(join(dir, 'node_modules', 'dep.js'), 'needle in ignored dir');
  mkdirSync(join(dir, '.git'));
  writeFileSync(join(dir, '.git', 'config'), 'needle in git');
  return dir;
}

function makeCtx(dir: string): ToolContext {
  return {
    cwd: dir,
    askPermission: async () => true,
  };
}

test('grep tool: finds pattern in files', async () => {
  const dir = createTestDir();
  try {
    const result = await grepTool.execute({ pattern: 'needle', path: dir }, makeCtx(dir));
    // Should not find in node_modules or .git
    assert.ok(!result.content.includes('node_modules'));
    assert.ok(!result.content.includes('.git'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('grep tool: finds simple text pattern', async () => {
  const dir = createTestDir();
  try {
    const result = await grepTool.execute({ pattern: 'hello', path: dir }, makeCtx(dir));
    assert.equal(result.isError, undefined);
    assert.ok(result.content.includes('a.txt'));
    assert.ok(result.content.includes('hello'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('grep tool: finds pattern in nested directories', async () => {
  const dir = createTestDir();
  try {
    const result = await grepTool.execute({ pattern: 'grepTool', path: dir }, makeCtx(dir));
    assert.equal(result.isError, undefined);
    assert.ok(result.content.includes('src/index.ts'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('grep tool: returns no matches when pattern not found', async () => {
  const dir = createTestDir();
  try {
    const result = await grepTool.execute({ pattern: 'zzzznotfound', path: dir }, makeCtx(dir));
    assert.equal(result.isError, undefined);
    assert.ok(result.content.includes('no matches'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('grep tool: respects .gitignore', async () => {
  const dir = createTestDir();
  try {
    const result = await grepTool.execute({ pattern: 'needle', path: dir }, makeCtx(dir));
    assert.ok(!result.content.includes('build/'));
    assert.ok(!result.content.includes('app.log'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('grep tool: skips node_modules and .git', async () => {
  const dir = createTestDir();
  try {
    const result = await grepTool.execute({ pattern: 'needle', path: dir }, makeCtx(dir));
    assert.ok(!result.content.includes('node_modules'));
    assert.ok(!result.content.includes('.git'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('grep tool: handles regex patterns', async () => {
  const dir = createTestDir();
  try {
    const result = await grepTool.execute({ pattern: 'hello\\s+\\w+', path: dir }, makeCtx(dir));
    assert.equal(result.isError, undefined);
    assert.ok(result.content.includes('a.txt'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('grep tool: shows file:line:content format', async () => {
  const dir = createTestDir();
  try {
    const result = await grepTool.execute({ pattern: 'hello', path: dir }, makeCtx(dir));
    // Format should be filepath:linenum:content
    assert.ok(result.content.includes('a.txt:1:hello world') || result.content.includes('a.txt:'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('grep tool: handles absolute path', async () => {
  const dir = createTestDir();
  try {
    const result = await grepTool.execute({ pattern: 'hello', path: dir }, makeCtx('/tmp'));
    assert.equal(result.isError, undefined);
    assert.ok(result.content.includes('a.txt'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('grep tool: handles relative path', async () => {
  const dir = createTestDir();
  try {
    const result = await grepTool.execute({ pattern: 'grepTool', path: 'src' }, makeCtx(dir));
    assert.equal(result.isError, undefined);
    assert.ok(result.content.includes('index.ts'));
    assert.ok(!result.content.includes('a.txt')); // should not search parent
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('grep tool: skips binary files', async () => {
  const dir = createTestDir();
  try {
    const binFile = join(dir, 'binary.bin');
    // Write a buffer with a null byte to make it look binary
    const buf = Buffer.alloc(100);
    buf[0] = 0x00; // null byte makes it look binary
    buf.write('needle', 1);
    writeFileSync(binFile, buf);
    const result = await grepTool.execute({ pattern: 'needle', path: dir }, makeCtx(dir));
    assert.ok(!result.content.includes('binary.bin'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('grep tool: uses default path . when not specified', async () => {
  const dir = createTestDir();
  try {
    const result = await grepTool.execute({ pattern: 'hello' }, makeCtx(dir));
    assert.equal(result.isError, undefined);
    assert.ok(result.content.includes('a.txt'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('grep tool: tool metadata and schema', () => {
  assert.equal(grepTool.name, 'grep');
  assert.ok(grepTool.description);
  assert.deepEqual(grepTool.inputSchema, {
    type: 'object',
    properties: {
      pattern: { type: 'string' },
      path: { type: 'string' },
    },
    required: ['pattern'],
  });
});
