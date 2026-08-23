import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createTools } from '../../src/tools/registry.ts';
import { ShellRegistry } from '../../src/tools/shell.ts';
import { matchesGlob } from '../../src/tools/glob.ts';
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolContext } from '../../src/tools/types.ts';
import { FileUndoRegistry } from '../../src/core/undo.ts';
import { clearSpilledOutputs } from '../../src/tools/output.ts';

const tools = createTools(new ShellRegistry(process.cwd()));

function makeCtx(overrides?: Partial<{ askPermission: ToolContext['askPermission']; undo: ToolContext['undo'] }>): ToolContext {
  return { cwd: process.cwd(), askPermission: overrides?.askPermission ?? (async () => true), ...(overrides?.undo ? { undo: overrides.undo } : {}) };
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

test('edit returns a unified diff of the change', async () => {
  const dir = join(tmpdir(), `dae-diff-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'e.txt');
  writeFileSync(file, 'foo bar baz');
  const editTool = tools.find((t) => t.name === 'edit')!;
  const r = await editTool.execute({ path: file, oldString: 'bar', newString: 'QUX' }, makeCtx());
  assert.equal(r.isError, undefined);
  assert.ok(r.diff, 'edit must return a diff');
  assert.ok(r.diff!.includes('-foo bar baz'));
  assert.ok(r.diff!.includes('+foo QUX baz'));
  rmSync(dir, { recursive: true, force: true });
});

test('edit snapshots the pre-edit content for /undo', async () => {
  const dir = join(tmpdir(), `dae-undo-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'e.txt');
  writeFileSync(file, 'before');
  const undo = new FileUndoRegistry();
  const editTool = tools.find((t) => t.name === 'edit')!;
  await editTool.execute({ path: file, oldString: 'before', newString: 'after' }, makeCtx({ undo }));
  assert.equal(undo.size, 1);
  const entry = await undo.undo(undefined);
  assert.equal(entry?.original, 'before');
  assert.equal(readFileSync(file, 'utf8'), 'before');
  rmSync(dir, { recursive: true, force: true });
});

test('write returns a create-diff (all additions) and snapshots a null original', async () => {
  const dir = join(tmpdir(), `dae-wdiff-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'n.txt');
  const undo = new FileUndoRegistry();
  const writeTool = tools.find((t) => t.name === 'write')!;
  const r = await writeTool.execute({ path: file, content: 'line1\nline2' }, makeCtx({ undo }));
  assert.equal(r.isError, undefined);
  assert.ok(r.diff?.includes('@@ -0,0 +1,2 @@'));
  assert.ok(r.diff?.includes('+line1'));
  assert.equal(undo.size, 1);
  // Undo deletes the created file.
  await undo.undo(undefined);
  assert.equal(existsSync(file), false);
  rmSync(dir, { recursive: true, force: true });
});

test('write overwrite returns a diff and snapshots the old content', async () => {
  const dir = join(tmpdir(), `dae-wov-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'o.txt');
  writeFileSync(file, 'old');
  const undo = new FileUndoRegistry();
  const writeTool = tools.find((t) => t.name === 'write')!;
  const r = await writeTool.execute({ path: file, content: 'new' }, makeCtx({ undo }));
  assert.equal(r.isError, undefined);
  assert.ok(r.diff?.includes('-old'));
  assert.ok(r.diff?.includes('+new'));
  const entry = await undo.undo(undefined);
  assert.equal(entry?.original, 'old');
  assert.equal(readFileSync(file, 'utf8'), 'old');
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

test('askPermission=true lets bash run (auto-approve mode needs no prompt)', async () => {
  const bashTool = tools.find((t) => t.name === 'bash')!;
  const r = await bashTool.execute({ command: 'echo hi' }, makeCtx({ askPermission: async () => true }));
  assert.equal(r.isError, undefined); // success results carry no isError flag
  assert.equal(r.content.trim(), 'hi');
});

test('askPermission=true lets write overwrite an existing file (auto-approve mode needs no prompt)', async () => {
  const dir = join(tmpdir(), `dae-auto-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'f.txt');
  writeFileSync(file, 'old');
  const writeTool = tools.find((t) => t.name === 'write')!;
  const r = await writeTool.execute({ path: file, content: 'new' }, makeCtx({ askPermission: async () => true }));
  assert.equal(r.isError, undefined); // overwrite allowed, not denied
  const readTool = tools.find((t) => t.name === 'read')!;
  const readBack = await readTool.execute({ path: file }, makeCtx());
  assert.equal(readBack.content, 'new');
  rmSync(dir, { recursive: true, force: true });
});

test('bash output over the cap is truncated and spilled to a readable temp file', async () => {
  const bashTool = tools.find((t) => t.name === 'bash')!;
  const big = 'x'.repeat(40_000);
  const r = await bashTool.execute({ command: `printf '%s' '${big}'` }, makeCtx());
  assert.ok(r.content.includes('[output truncated at'));
  const spillPath = r.content.match(/saved to ([^;]+);/)?.[1];
  assert.ok(spillPath, 'truncation note must include the spill file path');
  // The full output is on disk (the read tool applies the same cap, so check
  // the spill file directly).
  const onDisk = readFileSync(spillPath, 'utf8');
  assert.equal(onDisk, big);
  const readTool = tools.find((t) => t.name === 'read')!;
  const back = await readTool.execute({ path: spillPath }, makeCtx());
  assert.ok(back.content.startsWith(big.slice(0, 100))); // readable via read too
  // Spilled files are cleaned up on dispose so the temp dir does not accumulate.
  clearSpilledOutputs();
  assert.equal(existsSync(spillPath), false, 'spill file removed by clearSpilledOutputs');
});

test('read streams offset/limit from a file larger than the whole-read cap', async () => {
  const dir = join(tmpdir(), `dae-big-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'big.txt');
  // ~2MB: over the 1MB whole-read cap, so offset/limit must stream from disk.
  const line = '0123456789abcdefghij'.repeat(50); // 1000 chars per line
  writeFileSync(file, Array.from({ length: 2000 }, (_, i) => `${i}:${line}`).join('\n'));
  const readTool = tools.find((t) => t.name === 'read')!;
  const whole = await readTool.execute({ path: file }, makeCtx());
  assert.equal(whole.isError, true); // whole read refused
  assert.ok(whole.content.includes('offset/limit'));
  const r = await readTool.execute({ path: file, offset: 1995, limit: 5 }, makeCtx());
  assert.equal(r.isError, undefined);
  assert.ok(r.content.startsWith('1996\t1995:'));
  assert.ok(r.content.includes('1999\t1998:'));
  assert.ok(r.content.includes('2000\t1999:'));
  const last = r.content.split('\n').pop()!;
  assert.equal(last.split('\t').length, 2); // numbered lines
  rmSync(dir, { recursive: true, force: true });
});

test('grep respects .gitignore (CC/ripgrep-style)', async () => {
  const dir = join(tmpdir(), `dae-gi-${Date.now()}`);
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'generated'), { recursive: true });
  writeFileSync(join(dir, '.gitignore'), 'generated/\n*.log\n');
  writeFileSync(join(dir, 'keep.txt'), 'needle here\n');
  writeFileSync(join(dir, 'src', 'also.txt'), 'needle here\n');
  writeFileSync(join(dir, 'generated', 'skip.txt'), 'needle here\n');
  writeFileSync(join(dir, 'trace.log'), 'needle here\n');
  const grepTool = tools.find((t) => t.name === 'grep')!;
  const r = await grepTool.execute({ pattern: 'needle', path: dir }, makeCtx());
  assert.ok(r.content.includes('keep.txt'));
  assert.ok(r.content.includes('also.txt'));
  assert.ok(!r.content.includes('skip.txt'));
  assert.ok(!r.content.includes('trace.log'));
  rmSync(dir, { recursive: true, force: true });
});

test('grep skips binary files and caps matches', async () => {
  const dir = join(tmpdir(), `dae-bin-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'text.txt'), 'needle in text\n');
  writeFileSync(join(dir, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02, ...Buffer.from('needle')]));
  // 600 matching files → result capped at 500 with a note.
  for (let i = 0; i < 600; i++) writeFileSync(join(dir, `f${i}.txt`), `needle ${i}\n`);
  const grepTool = tools.find((t) => t.name === 'grep')!;
  const r = await grepTool.execute({ pattern: 'needle', path: dir }, makeCtx());
  assert.ok(!r.content.includes('bin.dat'));
  assert.ok(r.content.includes('[stopped at 500 matches'));
  const count = r.content.split('\n').filter((l) => l.includes(':needle')).length;
  assert.equal(count, 500);
  rmSync(dir, { recursive: true, force: true });
});
