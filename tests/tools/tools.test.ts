import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { tools } from '../../src/tools/registry.ts';
import { matchesGlob } from '../../src/tools/glob.ts';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolContext } from '../../src/tools/types.ts';

function makeCtx(overrides?: Partial<{ askPermission: ToolContext['askPermission'] }>): ToolContext {
  return { cwd: process.cwd(), askPermission: overrides?.askPermission ?? (async () => true) };
}

test('glob matcher: star, globstar, question', () => {
  assert.equal(matchesGlob('*.ts', 'a.ts'), true);
  assert.equal(matchesGlob('*.ts', 'a.js'), false);
  assert.equal(matchesGlob('src/**/*.ts', 'src/a/b.ts'), true);
  assert.equal(matchesGlob('a?c', 'abc'), true);
  assert.equal(matchesGlob('a?c', 'ac'), false);
});

test('write + read roundtrip in tmp dir', async () => {
  const dir = join(tmpdir(), `dae-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const writeTool = tools.find((t) => t.name === 'write')!;
  const readTool = tools.find((t) => t.name === 'read')!;
  await writeTool.execute({ path: join(dir, 'sub', 'f.txt'), content: 'hello' }, makeCtx());
  const r = await readTool.execute({ path: join(dir, 'sub', 'f.txt') }, makeCtx());
  assert.equal(r.content, 'hello');
  rmSync(dir, { recursive: true, force: true });
});

test('edit replaces exact string', async () => {
  const dir = join(tmpdir(), `dae-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'e.txt');
  writeFileSync(file, 'foo bar baz');
  const editTool = tools.find((t) => t.name === 'edit')!;
  await editTool.execute({ path: file, oldString: 'bar', newString: 'QUX' }, makeCtx());
  const readTool = tools.find((t) => t.name === 'read')!;
  const r = await readTool.execute({ path: file }, makeCtx());
  assert.equal(r.content, 'foo QUX baz');
  rmSync(dir, { recursive: true, force: true });
});

test('bash runs command and returns output', async () => {
  const bashTool = tools.find((t) => t.name === 'bash')!;
  const r = await bashTool.execute({ command: 'echo hello' }, makeCtx());
  assert.equal(r.content.trim(), 'hello');
});

test('bash denied by permission returns isError', async () => {
  const bashTool = tools.find((t) => t.name === 'bash')!;
  const r = await bashTool.execute({ command: 'echo hi' }, makeCtx({ askPermission: async () => false }));
  assert.equal(r.isError, true);
});
