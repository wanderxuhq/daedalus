import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersistentShell, ShellRegistry, ShellTimeoutError } from '../../src/tools/shell.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'daedalus-shell-'));

test('shell: runs a command and returns its output and exit code', async () => {
  const shell = new PersistentShell(process.cwd());
  const r = await shell.run('echo hello');
  assert.equal(r.output.trim(), 'hello');
  assert.equal(r.code, 0);
  assert.equal(r.cwd, process.cwd());
  shell.kill();
});

test('shell: cwd persists across commands (cd is not lost)', async () => {
  const dir = tmp();
  const shell = new PersistentShell(dir);
  const r1 = await shell.run('mkdir sub && cd sub && pwd');
  assert.equal(r1.output.trim(), join(dir, 'sub'));
  const r2 = await shell.run('pwd');
  assert.equal(r2.output.trim(), join(dir, 'sub'), 'cwd must survive the previous cd');
  // relative paths resolve from the persisted cwd
  const r3 = await shell.run('touch f.txt && ls');
  assert.ok(r3.output.includes('f.txt'));
  shell.kill();
  rmSync(dir, { recursive: true, force: true });
});

test('shell: exported env vars persist across commands', async () => {
  const shell = new PersistentShell(process.cwd());
  await shell.run('export DAEDALUS_TEST_VAR=persisted');
  const r = await shell.run('echo "$DAEDALUS_TEST_VAR"');
  assert.equal(r.output.trim(), 'persisted');
  shell.kill();
});

test('shell: `exit N` reports the exit code and the shell survives', async () => {
  const shell = new PersistentShell(process.cwd());
  const r1 = await shell.run('exit 7');
  assert.equal(r1.code, 7);
  // the EXIT trap printed the sentinel, so the shell is still usable
  const r2 = await shell.run('echo still-alive');
  assert.equal(r2.output.trim(), 'still-alive');
  assert.equal(r2.code, 0);
  shell.kill();
});

test('shell: stdin is /dev/null — cat/read return immediately instead of hanging', async () => {
  const shell = new PersistentShell(process.cwd());
  const start = Date.now();
  const r1 = await shell.run('cat');
  assert.equal(r1.code, 0);
  assert.equal(r1.output, ''); // EOF, no output
  const r2 = await shell.run('read x; echo "rc=$?"');
  assert.equal(r2.output.trim(), 'rc=1'); // read fails on EOF
  assert.ok(Date.now() - start < 5000, 'must not hang for the 120s timeout');
  shell.kill();
});

test('shell: multi-line commands run as one unit', async () => {
  const shell = new PersistentShell(process.cwd());
  const r = await shell.run('for i in 1 2 3; do\n  echo "line-$i"\ndone');
  assert.equal(r.code, 0);
  assert.deepEqual(r.output.trim().split('\n'), ['line-1', 'line-2', 'line-3']);
  shell.kill();
});

test('shell: a failing command returns its exit code and keeps the shell alive', async () => {
  const shell = new PersistentShell(process.cwd());
  const r1 = await shell.run('false');
  assert.equal(r1.code, 1);
  const r2 = await shell.run('echo after-failure');
  assert.equal(r2.output.trim(), 'after-failure');
  shell.kill();
});

test('shell: stdout and stderr are both captured', async () => {
  const shell = new PersistentShell(process.cwd());
  const r = await shell.run('echo out; echo err >&2');
  assert.ok(r.output.includes('out'));
  assert.ok(r.output.includes('err'));
  assert.equal(r.code, 0);
  shell.kill();
});

test('shell: kill -9 $$ kills the shell; the next call respawns at the tracked cwd', async () => {
  const dir = tmp();
  const shell = new PersistentShell(dir);
  await shell.run('cd sub && pwd').catch(() => {}); // dir/sub may not exist; ignore
  // Track a cwd that exists:
  await shell.run(`cd ${dir} && mkdir -p sub2 && cd sub2`);
  await assert.rejects(() => shell.run('kill -9 $$'), /shell exited unexpectedly/);
  const r = await shell.run('pwd');
  assert.equal(r.output.trim(), join(dir, 'sub2'), 'respawn must land on the last tracked cwd');
  shell.kill();
  rmSync(dir, { recursive: true, force: true });
});

test('shell: timeout kills the command group and the next call works', async () => {
  const shell = new PersistentShell(process.cwd());
  await assert.rejects(
    () => shell.run('sleep 30', { timeoutMs: 300 }),
    (e: unknown) => e instanceof ShellTimeoutError,
  );
  const r = await shell.run('echo recovered');
  assert.equal(r.output.trim(), 'recovered');
  shell.kill();
});

test('shell: abort signal kills the shell and surfaces a cancellation', async () => {
  const shell = new PersistentShell(process.cwd());
  const ac = new AbortController();
  const p = shell.run('sleep 30', { signal: ac.signal });
  setTimeout(() => ac.abort(), 100);
  await assert.rejects(p, /cancelled/);
  // next call respawns
  const r = await shell.run('echo after-abort');
  assert.equal(r.output.trim(), 'after-abort');
  shell.kill();
});

test('shell: commands serialize per shell (no interleaving)', async () => {
  const shell = new PersistentShell(process.cwd());
  const results = await Promise.all([
    shell.run('echo one && sleep 0.2'),
    shell.run('echo two'),
  ]);
  const outputs = results.map((r) => r.output.trim());
  // both run, each is complete; no sentinel interleaving
  assert.ok(outputs.includes('one'));
  assert.ok(outputs.includes('two'));
  shell.kill();
});

test('shell: registry gives each agent its own shell', async () => {
  const dir = tmp();
  const reg = new ShellRegistry(dir);
  const a = reg.get('workerA');
  const b = reg.get('workerB');
  assert.notEqual(a, b);
  await a.run('cd a-dir && pwd').catch(() => {});
  await a.run('mkdir -p a-dir && cd a-dir');
  const r = await b.run('pwd');
  assert.equal(r.output.trim(), dir, 'workerB must not see workerA\'s cd');
  assert.equal(reg.size, 2);
  reg.reset('workerA');
  assert.equal(reg.size, 1);
  reg.clear();
  assert.equal(reg.size, 0);
  rmSync(dir, { recursive: true, force: true });
});

test('shell: unnamed agents share the main shell', async () => {
  const reg = new ShellRegistry(process.cwd());
  assert.equal(reg.get(), reg.get(undefined));
  assert.equal(reg.get('main'), reg.get());
  reg.clear();
});

test('bash tool: persistent cwd across tool calls via the registry', async () => {
  const { createTools } = await import('../../src/tools/registry.ts');
  const dir = tmp();
  const shells = new ShellRegistry(dir);
  const tools = createTools(shells);
  const bash = tools.find((t) => t.name === 'bash')!;
  const ctx = {
    cwd: dir,
    askPermission: (async () => true) as (action: string, target: string) => Promise<boolean>,
    agent: 'test',
  };
  const r1 = await bash.execute({ command: 'mkdir -p deep && cd deep' }, ctx);
  assert.equal(r1.isError, undefined);
  const r2 = await bash.execute({ command: 'pwd' }, ctx);
  assert.equal(r2.content.trim(), join(dir, 'deep'));
  shells.clear();
  rmSync(dir, { recursive: true, force: true });
});
