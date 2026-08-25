import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBashTool } from '../../src/tools/bash.ts';
import { ShellRegistry } from '../../src/tools/shell.ts';
import { FileLockRegistry } from '../../src/core/file-lock.ts';
import { FileUndoRegistry } from '../../src/core/undo.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'daedalus-bash-'));

test('bash tool: runs a command and returns output', async () => {
  const dir = tmp();
  const shells = new ShellRegistry(dir);
  const tool = createBashTool(shells);
  const ctx = {
    cwd: dir,
    askPermission: async () => true,
    agent: 'test',
    locks: new FileLockRegistry(),
    undo: new FileUndoRegistry(),
  };
  
  const result = await tool.execute({ command: 'echo hello world' }, ctx);
  assert.equal(result.content.trim(), 'hello world');
  assert.equal(result.isError, undefined);
  
  shells.clear();
  rmSync(dir, { recursive: true, force: true });
});

test('bash tool: returns error on permission denial', async () => {
  const dir = tmp();
  const shells = new ShellRegistry(dir);
  const tool = createBashTool(shells);
  const ctx = {
    cwd: dir,
    askPermission: async () => false,
    agent: 'test',
  };
  
  const result = await tool.execute({ command: 'echo should not run' }, ctx);
  assert.equal(result.content, 'Permission denied by user');
  assert.equal(result.isError, true);
  
  shells.clear();
  rmSync(dir, { recursive: true, force: true });
});

test('bash tool: handles command execution errors', async () => {
  const dir = tmp();
  const shells = new ShellRegistry(dir);
  const tool = createBashTool(shells);
  const ctx = {
    cwd: dir,
    askPermission: async () => true,
    agent: 'test',
  };
  
  const result = await tool.execute({ command: 'exit 42' }, ctx);
  assert.ok(result.content.includes('exit 42'));
  assert.equal(result.isError, true);
  
  shells.clear();
  rmSync(dir, { recursive: true, force: true });
});

test('bash tool: persists working directory across calls', async () => {
  const dir = tmp();
  const shells = new ShellRegistry(dir);
  const tool = createBashTool(shells);
  const ctx = {
    cwd: dir,
    askPermission: async () => true,
    agent: 'test',
  };
  
  // Create a subdirectory and cd into it
  await tool.execute({ command: 'mkdir -p subdir && cd subdir' }, ctx);
  const result = await tool.execute({ command: 'pwd' }, ctx);
  
  assert.equal(result.content.trim(), join(dir, 'subdir'));
  assert.equal(result.isError, undefined);
  
  shells.clear();
  rmSync(dir, { recursive: true, force: true });
});

test('bash tool: persists environment variables', async () => {
  const dir = tmp();
  const shells = new ShellRegistry(dir);
  const tool = createBashTool(shells);
  const ctx = {
    cwd: dir,
    askPermission: async () => true,
    agent: 'test',
  };
  
  await tool.execute({ command: 'export TEST_VAR=hello' }, ctx);
  const result = await tool.execute({ command: 'echo $TEST_VAR' }, ctx);
  
  assert.equal(result.content.trim(), 'hello');
  assert.equal(result.isError, undefined);
  
  shells.clear();
  rmSync(dir, { recursive: true, force: true });
});

test('bash tool: handles multi-line commands', async () => {
  const dir = tmp();
  const shells = new ShellRegistry(dir);
  const tool = createBashTool(shells);
  const ctx = {
    cwd: dir,
    askPermission: async () => true,
    agent: 'test',
  };
  
  const result = await tool.execute({ 
    command: 'for i in 1 2 3; do\necho "item-$i"\ndone' 
  }, ctx);
  
  assert.ok(result.content.includes('item-1'));
  assert.ok(result.content.includes('item-2'));
  assert.ok(result.content.includes('item-3'));
  assert.equal(result.isError, undefined);
  
  shells.clear();
  rmSync(dir, { recursive: true, force: true });
});

test('bash tool: handles commands that fail', async () => {
  const dir = tmp();
  const shells = new ShellRegistry(dir);
  const tool = createBashTool(shells);
  const ctx = {
    cwd: dir,
    askPermission: async () => true,
    agent: 'test',
  };
  
  const result = await tool.execute({ command: 'ls /nonexistent/path' }, ctx);
  assert.equal(result.isError, true);
  
  shells.clear();
  rmSync(dir, { recursive: true, force: true });
});

test('bash tool: returns no output for commands that produce none', async () => {
  const dir = tmp();
  const shells = new ShellRegistry(dir);
  const tool = createBashTool(shells);
  const ctx = {
    cwd: dir,
    askPermission: async () => true,
    agent: 'test',
  };
  
  const result = await tool.execute({ command: 'true' }, ctx);
  assert.equal(result.content, '(no output)');
  assert.equal(result.isError, undefined);
  
  shells.clear();
  rmSync(dir, { recursive: true, force: true });
});

test('bash tool: uses per-agent shell isolation', async () => {
  const dir = tmp();
  const shells = new ShellRegistry(dir);
  const tool = createBashTool(shells);
  
  const ctx1 = {
    cwd: dir,
    askPermission: async () => true,
    agent: 'agent1',
  };
  
  const ctx2 = {
    cwd: dir,
    askPermission: async () => true,
    agent: 'agent2',
  };
  
  // Agent1 changes directory
  await tool.execute({ command: 'mkdir -p agent1dir && cd agent1dir' }, ctx1);
  const result1 = await tool.execute({ command: 'pwd' }, ctx1);
  assert.equal(result1.content.trim(), join(dir, 'agent1dir'));
  
  // Agent2 should be unaffected
  const result2 = await tool.execute({ command: 'pwd' }, ctx2);
  assert.equal(result2.content.trim(), dir);
  
  shells.clear();
  rmSync(dir, { recursive: true, force: true });
});

test('bash tool: handles timeout', async () => {
  const dir = tmp();
  const shells = new ShellRegistry(dir);
  const tool = createBashTool(shells);
  const ctx = {
    cwd: dir,
    askPermission: async () => true,
    agent: 'test',
    signal: AbortSignal.timeout(100),
  };
  
  const result = await tool.execute({ command: 'sleep 10' }, ctx);
  // Should either be an error or cancelled
  assert.ok(result.isError || result.content.includes('cancelled'));
  
  shells.clear();
  rmSync(dir, { recursive: true, force: true });
});

test('bash tool: handles invalid input', async () => {
  const dir = tmp();
  const shells = new ShellRegistry(dir);
  const tool = createBashTool(shells);
  const ctx = {
    cwd: dir,
    askPermission: async () => true,
    agent: 'test',
  };
  
  // Missing command property
  const result = await tool.execute({} as any, ctx);
  assert.equal(result.isError, true);
  
  shells.clear();
  rmSync(dir, { recursive: true, force: true });
});