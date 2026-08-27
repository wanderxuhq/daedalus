import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadMcpConfig } from '../../src/mcp/config.ts';

test('loadMcpConfig returns empty object when file does not exist', () => {
  const result = loadMcpConfig('/nonexistent/path/mcp.json');
  assert.deepEqual(result, {});
});

test('loadMcpConfig parses valid mcp.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-test-'));
  const filePath = join(dir, 'mcp.json');
  writeFileSync(filePath, JSON.stringify({
    mcpServers: {
      fs: { command: 'npx', args: ['-y', 'server'], env: { A: '1' } },
    },
  }));
  const result = loadMcpConfig(filePath);
  assert.deepEqual(result, {
    mcpServers: {
      fs: { command: 'npx', args: ['-y', 'server'], env: { A: '1' } },
    },
  });
  rmSync(dir, { recursive: true, force: true });
});

test('loadMcpConfig returns empty object for invalid JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-test-'));
  const filePath = join(dir, 'mcp.json');
  writeFileSync(filePath, 'not json{{{');
  const result = loadMcpConfig(filePath);
  assert.deepEqual(result, {});
  rmSync(dir, { recursive: true, force: true });
});

test('loadMcpConfig returns empty object when mcpServers is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-test-'));
  const filePath = join(dir, 'mcp.json');
  writeFileSync(filePath, JSON.stringify({ other: true }));
  const result = loadMcpConfig(filePath);
  assert.deepEqual(result, {});
  rmSync(dir, { recursive: true, force: true });
});

test('loadMcpConfig defaults to ~/.daedalus/mcp.json when no path given', () => {
  const result = loadMcpConfig();
  assert.ok(typeof result === 'object');
});
