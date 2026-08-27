import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { McpServerConfig, McpServerStatus, McpConnectionState } from '../../src/mcp/types.ts';

test('McpServerConfig shape', () => {
  const config: McpServerConfig = {
    command: 'npx',
    args: ['arg1'],
    env: { KEY: 'value' },
  };
  assert.equal(config.command, 'npx');
  assert.deepEqual(config.args, ['arg1']);
  assert.deepEqual(config.env, { KEY: 'value' });
});

test('McpServerConfig args and env are optional', () => {
  const config: McpServerConfig = { command: 'node' };
  assert.equal(config.command, 'node');
  assert.equal(config.args, undefined);
  assert.equal(config.env, undefined);
});

test('McpConnectionState values', () => {
  const states: McpConnectionState[] = ['connecting', 'connected', 'failed'];
  assert.ok(states.includes('connecting'));
  assert.ok(states.includes('connected'));
  assert.ok(states.includes('failed'));
});

test('McpServerStatus shape', () => {
  const status: McpServerStatus = {
    name: 'test',
    state: 'connected',
    toolCount: 3,
    resourceCount: 1,
    promptCount: 0,
  };
  assert.equal(status.name, 'test');
  assert.equal(status.state, 'connected');
  assert.equal(status.toolCount, 3);
});
