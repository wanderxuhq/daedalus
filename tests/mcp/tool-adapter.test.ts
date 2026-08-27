import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wrapMcpTool, createResourceTool, createPromptTool, formatMcpResult } from '../../src/mcp/tool-adapter.ts';
import type { Tool } from '../../src/tools/types.ts';

test('wrapMcpTool creates a Daedalus Tool from an MCP tool definition', () => {
  const fakeClient = {
    callTool: async () => ({ content: [{ type: 'text', text: 'hello' }] }),
  };
  const mcpDef = {
    name: 'read_file',
    description: 'Read a file',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  };
  const tool = wrapMcpTool(mcpDef, 'myserver', fakeClient as any);
  assert.equal(tool.name, 'mcp__myserver__read_file');
  assert.equal(tool.description, 'Read a file');
  assert.deepEqual(tool.inputSchema, { type: 'object', properties: { path: { type: 'string' } } });
});

test('wrapMcpTool execute calls client.callTool and returns result', async () => {
  const fakeClient = {
    callTool: async (params: any) => {
      return { content: [{ type: 'text', text: `result for ${params.name}` }] };
    },
  };
  const mcpDef = { name: 'do_thing', description: 'Do thing', inputSchema: {} };
  const tool = wrapMcpTool(mcpDef, 'srv', fakeClient as any);
  const ctx = { cwd: '/tmp', askPermission: async () => true };
  const result = await tool.execute({ arg: 1 }, ctx);
  assert.equal(result.content, 'result for do_thing');
  assert.equal(result.isError, undefined);
});

test('wrapMcpTool execute returns error result on failure', async () => {
  const fakeClient = {
    callTool: async () => { throw new Error('connection lost'); },
  };
  const mcpDef = { name: 'fail_tool', description: 'Fails', inputSchema: {} };
  const tool = wrapMcpTool(mcpDef, 'srv', fakeClient as any);
  const ctx = { cwd: '/tmp', askPermission: async () => true };
  const result = await tool.execute({}, ctx);
  assert.ok(result.isError);
  assert.ok(result.content.includes('connection lost'));
});

test('wrapMcpTool namespacing prevents collisions', () => {
  const fakeClient = { callTool: async () => ({ content: [] }) };
  const t1 = wrapMcpTool({ name: 'read', description: 'x', inputSchema: {} }, 'a', fakeClient as any);
  const t2 = wrapMcpTool({ name: 'read', description: 'x', inputSchema: {} }, 'b', fakeClient as any);
  assert.equal(t1.name, 'mcp__a__read');
  assert.equal(t2.name, 'mcp__b__read');
  assert.notEqual(t1.name, t2.name);
});

test('formatMcpResult handles text content', () => {
  const result = { content: [{ type: 'text', text: 'hello world' }] };
  assert.equal(formatMcpResult(result), 'hello world');
});

test('formatMcpResult handles multiple content items', () => {
  const result = {
    content: [
      { type: 'text', text: 'line 1' },
      { type: 'text', text: 'line 2' },
    ],
  };
  assert.equal(formatMcpResult(result), 'line 1\nline 2');
});

test('formatMcpResult handles empty content', () => {
  assert.equal(formatMcpResult({ content: [] }), '(no output)');
});

test('createResourceTool returns a valid Tool', () => {
  const fakeManager = {
    readResource: async () => ({ contents: [{ uri: 'file:///x', text: 'data' }] }),
    getResourceList: () => [{ server: 's', uri: 'file:///x', name: 'x' }],
  };
  const tool = createResourceTool(fakeManager as any);
  assert.equal(tool.name, 'mcp_read_resource');
  assert.ok(tool.description.includes('MCP'));
  assert.ok(tool.inputSchema);
});

test('createPromptTool returns a valid Tool', () => {
  const fakeManager = {
    getPrompt: async () => ({ messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }] }),
    getPromptList: () => [{ server: 's', name: 'p1', description: 'A prompt' }],
  };
  const tool = createPromptTool(fakeManager as any);
  assert.equal(tool.name, 'mcp_get_prompt');
  assert.ok(tool.description.includes('MCP'));
  assert.ok(tool.inputSchema);
});
