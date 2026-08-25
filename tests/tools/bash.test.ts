import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBashTool } from '../../src/tools/bash.ts';
import { ShellRegistry } from '../../src/tools/shell.ts';
import type { ToolContext } from '../../src/tools/types.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'daedalus-bash-test-'));

test('bash tool: returns permission denied when user rejects', async () => {
  const shells = new ShellRegistry(process.cwd());
  const tool = createBashTool(shells);
  const ctx: ToolContext = {
    cwd: '/tmp',
    askPermission: async () => false,
    agent: 'test',
  };

  const result = await tool.execute({ command: 'echo test' }, ctx);
  assert.equal(result.isError, true);
  assert.ok(result.content.includes('Permission denied'));
  shells.clear();
});

test('bash tool: executes successful command', async () => {
  const shells = new ShellRegistry(process.cwd());
  const tool = createBashTool(shells);
  const ctx: ToolContext = {
    cwd: '/tmp',
    askPermission: async () => true,
    agent: 'test',
  };

  const result = await tool.execute({ command: 'echo hello' }, ctx);
  assert.equal(result.isError, undefined);
  assert.ok(result.content.includes('hello'));
  shells.clear();
});

test('bash tool: handles command failure (non-zero exit)', async () => {
  const shells = new ShellRegistry(process.cwd());
  const tool = createBashTool(shells);
  const ctx: ToolContext = {
    cwd: '/tmp',
    askPermission: async () => true,
    agent: 'test',
  };

  const result = await tool.execute({ command: 'exit 1' }, ctx);
  assert.equal(result.isError, true);
  assert.ok(result.content.includes('exit 1'));
  shells.clear();
});

test('bash tool: handles command failure with non-zero exit code', async () => {
  const shells = new ShellRegistry(process.cwd());
  const tool = createBashTool(shells);
  const ctx: ToolContext = {
    cwd: '/tmp',
    askPermission: async () => true,
    agent: 'test',
  };

  const result = await tool.execute({ command: 'false' }, ctx);
  assert.equal(result.isError, true);
  assert.ok(result.content.includes('exit'));
  shells.clear();
});

test('bash tool: handles empty command output', async () => {
  const shells = new ShellRegistry(process.cwd());
  const tool = createBashTool(shells);
  const ctx: ToolContext = {
    cwd: '/tmp',
    askPermission: async () => true,
    agent: 'test',
  };

  const result = await tool.execute({ command: 'true' }, ctx);
  assert.equal(result.isError, undefined);
  // Command succeeded with no output - should return "(no output)" or empty
  assert.ok(result.content.includes('(no output)') || result.content.trim() === '');
  shells.clear();
});

test('bash tool: handles abort signal', async () => {
  const shells = new ShellRegistry(process.cwd());
  const tool = createBashTool(shells);
  const ac = new AbortController();
  const ctx: ToolContext = {
    cwd: '/tmp',
    askPermission: async () => true,
    agent: 'test',
    signal: ac.signal,
  };

  const promise = tool.execute({ command: 'sleep 30' }, ctx);
  setTimeout(() => ac.abort(), 100);

  const result = await promise;
  assert.equal(result.isError, true);
  assert.ok(result.content.includes('cancelled'));
  shells.clear();
});

test('bash tool: persists cwd across calls via shell registry', async () => {
  const dir = tmp();
  const shells = new ShellRegistry(dir);
  const tool = createBashTool(shells);
  const ctx: ToolContext = {
    cwd: dir,
    askPermission: async () => true,
    agent: 'test',
  };

  const r1 = await tool.execute({ command: 'mkdir -p sub && cd sub' }, ctx);
  assert.equal(r1.isError, undefined);

  const r2 = await tool.execute({ command: 'pwd' }, ctx);
  assert.equal(r2.content.trim(), join(dir, 'sub'));
  shells.clear();
  rmSync(dir, { recursive: true, force: true });
});

test('bash tool: returns tool description and schema', () => {
  const shells = new ShellRegistry(process.cwd());
  const tool = createBashTool(shells);

  assert.equal(tool.name, 'bash');
  assert.ok(tool.description.includes('shell command'));
  assert.deepEqual(tool.inputSchema, {
    type: 'object',
    properties: { command: { type: 'string' } },
    required: ['command'],
  });
  shells.clear();
});

test('bash tool: handles shell respawn after exit', async () => {
  const dir = tmp();
  const shells = new ShellRegistry(dir);
  const tool = createBashTool(shells);
  const ctx: ToolContext = {
    cwd: dir,
    askPermission: async () => true,
    agent: 'test',
  };

  // First command - creates a dir and cd's into it
  const r1 = await tool.execute({ command: 'mkdir -p deep && cd deep' }, ctx);
  assert.equal(r1.isError, undefined);

  // Second command - run exit to kill the shell
  await tool.execute({ command: 'exit 42' }, ctx);

  // Third command - shell should respawn at tracked cwd (deep)
  const r3 = await tool.execute({ command: 'pwd' }, ctx);
  assert.equal(r3.content.trim(), join(dir, 'deep'));
  shells.clear();
  rmSync(dir, { recursive: true, force: true });
});

test('bash tool: captures stderr output', async () => {
  const shells = new ShellRegistry(process.cwd());
  const tool = createBashTool(shells);
  const ctx: ToolContext = {
    cwd: '/tmp',
    askPermission: async () => true,
    agent: 'test',
  };

  const result = await tool.execute({ command: 'echo out; echo err >&2' }, ctx);
  assert.equal(result.isError, undefined);
  assert.ok(result.content.includes('out'));
  assert.ok(result.content.includes('err'));
  shells.clear();
});

test('bash tool: handles multi-line commands', async () => {
  const shells = new ShellRegistry(process.cwd());
  const tool = createBashTool(shells);
  const ctx: ToolContext = {
    cwd: '/tmp',
    askPermission: async () => true,
    agent: 'test',
  };

  const result = await tool.execute({ command: 'for i in 1 2 3; do\n  echo "line-$i"\ndone' }, ctx);
  assert.equal(result.isError, undefined);
  assert.ok(result.content.includes('line-1'));
  assert.ok(result.content.includes('line-2'));
  assert.ok(result.content.includes('line-3'));
  shells.clear();
});

test('bash tool: permission is requested with correct parameters', async () => {
  const shells = new ShellRegistry(process.cwd());
  const tool = createBashTool(shells);
  const command = 'echo test-command';
  let receivedAction = '';
  let receivedTarget = '';

  const ctx: ToolContext = {
    cwd: '/tmp',
    askPermission: async (action: string, target: string) => {
      receivedAction = action;
      receivedTarget = target;
      return true;
    },
    agent: 'test',
  };

  await tool.execute({ command }, ctx);
  assert.equal(receivedAction, 'bash');
  assert.equal(receivedTarget, command);
  shells.clear();
});

test('bash tool: handles different exit codes correctly', async () => {
  const shells = new ShellRegistry(process.cwd());
  const tool = createBashTool(shells);
  const ctx: ToolContext = {
    cwd: '/tmp',
    askPermission: async () => true,
    agent: 'test',
  };

  // Test exit code 1
  const r1 = await tool.execute({ command: 'exit 1' }, ctx);
  assert.equal(r1.isError, true);
  assert.ok(r1.content.includes('exit 1'));

  // Test exit code 2
  const r2 = await tool.execute({ command: 'exit 2' }, ctx);
  assert.equal(r2.isError, true);
  assert.ok(r2.content.includes('exit 2'));

  // Test exit code 127 (command not found style)
  const r3 = await tool.execute({ command: 'exit 127' }, ctx);
  assert.equal(r3.isError, true);
  assert.ok(r3.content.includes('exit 127'));
  shells.clear();
});
