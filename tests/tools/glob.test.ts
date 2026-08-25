import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { globTool, matchesGlob } from '../../src/tools/glob.ts';
import type { ToolContext } from '../../src/tools/types.ts';

function createTestDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'daedalus-glob-test-'));
  writeFileSync(join(dir, 'a.ts'), 'export const a = 1;');
  writeFileSync(join(dir, 'b.ts'), 'export const b = 2;');
  writeFileSync(join(dir, 'c.js'), 'module.exports = {};');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'index.ts'), 'import a from "./a";');
  mkdirSync(join(dir, 'src', 'utils'));
  writeFileSync(join(dir, 'src', 'utils', 'helpers.ts'), 'export function helper() {}');
  // Create ignored directories
  mkdirSync(join(dir, 'node_modules'));
  writeFileSync(join(dir, 'node_modules', 'dep.js'), 'ignored');
  mkdirSync(join(dir, '.git'));
  writeFileSync(join(dir, '.git', 'config'), 'ignored');
  return dir;
}

function makeCtx(dir: string): ToolContext {
  return {
    cwd: dir,
    askPermission: async () => true,
  };
}

test('matchesGlob: star pattern', () => {
  assert.equal(matchesGlob('*.ts', 'a.ts'), true);
  assert.equal(matchesGlob('*.ts', 'b.js'), false);
  assert.equal(matchesGlob('*.ts', 'src/index.ts'), false); // * doesn't cross directories
});

test('matchesGlob: globstar pattern', () => {
  assert.equal(matchesGlob('**/*.ts', 'src/index.ts'), true);
  assert.equal(matchesGlob('**/*.ts', 'src/utils/helpers.ts'), true);
  assert.equal(matchesGlob('**/*.ts', 'a.ts'), true);
  assert.equal(matchesGlob('**/*.ts', 'c.js'), false);
});

test('matchesGlob: question mark pattern', () => {
  assert.equal(matchesGlob('?.ts', 'a.ts'), true);
  assert.equal(matchesGlob('?.ts', 'ab.ts'), false);
  assert.equal(matchesGlob('?.ts', 'a.js'), false);
});

test('matchesGlob: escapes regex special characters', () => {
  assert.equal(matchesGlob('a+b.ts', 'a+b.ts'), true);
  assert.equal(matchesGlob('a+b.ts', 'axb.ts'), false);
  assert.equal(matchesGlob('(foo).ts', '(foo).ts'), true);
  assert.equal(matchesGlob('[abc].ts', '[abc].ts'), true);
});

test('matchesGlob: combined patterns', () => {
  assert.equal(matchesGlob('src/**/*.ts', 'src/index.ts'), true);
  assert.equal(matchesGlob('src/**/*.ts', 'src/utils/helpers.ts'), true);
  assert.equal(matchesGlob('src/**/*.ts', 'a.ts'), false);
});

test('glob tool: finds files with simple pattern', async () => {
  const dir = createTestDir();
  try {
    const result = await globTool.execute({ pattern: '*.ts' }, makeCtx(dir));
    assert.equal(result.isError, undefined);
    assert.ok(result.content.includes('a.ts'));
    assert.ok(result.content.includes('b.ts'));
    assert.ok(!result.content.includes('c.js'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('glob tool: finds files with recursive pattern', async () => {
  const dir = createTestDir();
  try {
    const result = await globTool.execute({ pattern: '**/*.ts' }, makeCtx(dir));
    assert.equal(result.isError, undefined);
    assert.ok(result.content.includes('a.ts'));
    assert.ok(result.content.includes('src/index.ts'));
    assert.ok(result.content.includes('src/utils/helpers.ts'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('glob tool: skips node_modules and .git', async () => {
  const dir = createTestDir();
  try {
    const result = await globTool.execute({ pattern: '**/*.js' }, makeCtx(dir));
    assert.equal(result.isError, undefined);
    assert.ok(!result.content.includes('node_modules'));
    assert.ok(!result.content.includes('.git'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('glob tool: returns no matches message when nothing matches', async () => {
  const dir = createTestDir();
  try {
    const result = await globTool.execute({ pattern: '*.py' }, makeCtx(dir));
    assert.equal(result.isError, undefined);
    assert.ok(result.content.includes('no matches'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('glob tool: handles absolute path', async () => {
  const dir = createTestDir();
  try {
    const result = await globTool.execute({ pattern: '*.ts', path: dir }, makeCtx('/tmp'));
    assert.equal(result.isError, undefined);
    assert.ok(result.content.includes('a.ts'));
    assert.ok(result.content.includes('b.ts'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('glob tool: handles relative path', async () => {
  const dir = createTestDir();
  try {
    const result = await globTool.execute({ pattern: '*.ts', path: 'src' }, makeCtx(dir));
    assert.equal(result.isError, undefined);
    assert.ok(result.content.includes('index.ts'));
    assert.ok(!result.content.includes('helpers.ts')); // nested deeper
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('glob tool: returns empty result for empty directory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'daedalus-glob-empty-'));
  try {
    const result = await globTool.execute({ pattern: '*.ts' }, makeCtx(dir));
    assert.equal(result.isError, undefined);
    assert.ok(result.content.includes('no matches'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('glob tool: tool metadata and schema', () => {
  assert.equal(globTool.name, 'glob');
  assert.ok(globTool.description);
  assert.deepEqual(globTool.inputSchema, {
    type: 'object',
    properties: {
      pattern: { type: 'string' },
      path: { type: 'string' },
    },
    required: ['pattern'],
  });
});
