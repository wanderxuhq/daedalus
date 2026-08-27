import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt } from '../../src/core/system-prompt.ts';

test('buildSystemPrompt includes MCP tools in tool list', () => {
  const prompt = buildSystemPrompt({
    tools: ['read', 'write', 'mcp__fs__read_file'],
    mcpToolLines: {
      'mcp__fs__read_file': '- mcp__fs__read_file (MCP: filesystem): Read a file from the filesystem',
    },
  });
  assert.ok(prompt.includes('mcp__fs__read_file'));
  assert.ok(prompt.includes('filesystem'));
});

test('buildSystemPrompt includes MCP meta-tools', () => {
  const prompt = buildSystemPrompt({
    tools: ['read', 'mcp_read_resource', 'mcp_list_resources'],
    mcpToolLines: {
      'mcp_read_resource': '- mcp_read_resource: Read an MCP resource',
      'mcp_list_resources': '- mcp_list_resources: List MCP resources',
    },
  });
  assert.ok(prompt.includes('mcp_read_resource'));
  assert.ok(prompt.includes('mcp_list_resources'));
});

test('buildSystemPrompt handles empty mcpToolLines gracefully', () => {
  const prompt = buildSystemPrompt({
    tools: ['read'],
    mcpToolLines: {},
  });
  assert.ok(!prompt.includes('mcp_'));
});
