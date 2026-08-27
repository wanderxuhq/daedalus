import type { Tool, ToolContext, ToolResult } from '../tools/types.ts';

/** Minimal shape of an MCP Client that we need to call tools/resources/prompts. */
export interface McpToolClient {
  callTool(params: { name: string; arguments?: unknown }): Promise<{ content: Array<{ type: string; text?: string; [key: string]: unknown }> }>;
}

/** Minimal shape of the MCP resource interface on a client. */
export interface McpResourceClient {
  listResources(): Promise<{ resources: Array<{ uri: string; name: string; description?: string; mimeType?: string }> }>;
  readResource(params: { uri: string }): Promise<{ contents: Array<{ uri: string; text?: string; blob?: string; mimeType?: string }> }>;
}

/** Minimal shape of the MCP prompt interface on a client. */
export interface McpPromptClient {
  listPrompts(): Promise<{ prompts: Array<{ name: string; description?: string; arguments?: Array<{ name: string; description?: string; required?: boolean }> }> }>;
  getPrompt(params: { name: string; arguments?: Record<string, string> }): Promise<{ messages: Array<{ role: string; content: { type: string; text?: string } }> }>;
}

/**
 * Format an MCP tool result into a plain string for the Daedalus ToolResult.
 */
export function formatMcpResult(result: { content: Array<{ type: string; text?: string; [key: string]: unknown }> }): string {
  if (!result.content || result.content.length === 0) return '(no output)';
  return result.content
    .filter((c) => c.type === 'text' && c.text != null)
    .map((c) => c.text!)
    .join('\n');
}

/**
 * Wrap an MCP tool definition as a native Daedalus Tool.
 * The name is namespaced: mcp__<serverName>__<toolName>.
 */
export function wrapMcpTool(
  mcpTool: { name: string; description: string; inputSchema: unknown },
  serverName: string,
  client: McpToolClient,
): Tool {
  return {
    name: `mcp__${serverName}__${mcpTool.name}`,
    description: mcpTool.description,
    inputSchema: mcpTool.inputSchema,
    execute: async (input: unknown, _ctx: ToolContext): Promise<ToolResult> => {
      try {
        const result = await client.callTool({ name: mcpTool.name, arguments: input });
        return { content: formatMcpResult(result) };
      } catch (e) {
        return { content: `MCP tool error: ${(e as Error).message}`, isError: true };
      }
    },
  };
}

/** Type for the manager-like object that createResourceTool/createPromptTool need. */
export interface McpResourceReader {
  readResource(server: string, uri: string): Promise<{ contents: Array<{ uri: string; text?: string; blob?: string }> }>;
  getResourceList(): Array<{ server: string; uri: string; name: string; description?: string }>;
}

export interface McpPromptReader {
  getPrompt(server: string, name: string, args?: Record<string, string>): Promise<{ messages: Array<{ role: string; content: { type: string; text?: string } }> }>;
  getPromptList(): Array<{ server: string; name: string; description?: string }>;
}

/**
 * Create a Daedalus Tool that reads MCP resources.
 * Available on the main agent so the model can browse MCP data sources.
 */
export function createResourceTool(manager: McpResourceReader): Tool {
  return {
    name: 'mcp_read_resource',
    description: 'Read an MCP resource (file, data, etc.) exposed by a connected MCP server. Use mcp_list_resources first to discover available resources.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        server: { type: 'string', description: 'MCP server name' },
        uri: { type: 'string', description: 'Resource URI to read (get from mcp_list_resources)' },
      },
      required: ['server', 'uri'],
    },
    execute: async (input: unknown, _ctx: ToolContext): Promise<ToolResult> => {
      const { server, uri } = input as { server: string; uri: string };
      try {
        const result = await manager.readResource(server, uri);
        const text = result.contents
          .map((c) => c.text ?? `(binary: ${c.uri})`)
          .join('\n');
        return { content: text || '(no content)' };
      } catch (e) {
        return { content: `MCP resource error: ${(e as Error).message}`, isError: true };
      }
    },
  };
}

/**
 * Create a Daedalus Tool that lists MCP resources across all servers.
 */
export function createResourceListTool(manager: McpResourceReader): Tool {
  return {
    name: 'mcp_list_resources',
    description: 'List all available MCP resources across connected servers.',
    inputSchema: { type: 'object' as const, properties: {} },
    execute: async (_input: unknown, _ctx: ToolContext): Promise<ToolResult> => {
      const list = manager.getResourceList();
      if (list.length === 0) return { content: 'No MCP resources available.' };
      const lines = list.map((r) => `- [${r.server}] ${r.uri}${r.description ? ` — ${r.description}` : ''}`);
      return { content: lines.join('\n') };
    },
  };
}

/**
 * Create a Daedalus Tool that gets an MCP prompt template.
 */
export function createPromptTool(manager: McpPromptReader): Tool {
  return {
    name: 'mcp_get_prompt',
    description: 'Get a prompt template from a connected MCP server. Use mcp_list_prompts first to discover available prompts.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        server: { type: 'string', description: 'MCP server name' },
        name: { type: 'string', description: 'Prompt name (get from mcp_list_prompts)' },
        arguments: { type: 'object', description: 'Prompt arguments as key-value pairs', additionalProperties: { type: 'string' } },
      },
      required: ['server', 'name'],
    },
    execute: async (input: unknown, _ctx: ToolContext): Promise<ToolResult> => {
      const { server, name, arguments: args } = input as { server: string; name: string; arguments?: Record<string, string> };
      try {
        const result = await manager.getPrompt(server, name, args);
        const text = result.messages
          .map((m) => `[${m.role}]: ${m.content.text ?? ''}`)
          .join('\n\n');
        return { content: text || '(no prompt content)' };
      } catch (e) {
        return { content: `MCP prompt error: ${(e as Error).message}`, isError: true };
      }
    },
  };
}

/**
 * Create a Daedalus Tool that lists MCP prompts across all servers.
 */
export function createPromptListTool(manager: McpPromptReader): Tool {
  return {
    name: 'mcp_list_prompts',
    description: 'List all available MCP prompts across connected servers.',
    inputSchema: { type: 'object' as const, properties: {} },
    execute: async (_input: unknown, _ctx: ToolContext): Promise<ToolResult> => {
      const list = manager.getPromptList();
      if (list.length === 0) return { content: 'No MCP prompts available.' };
      const lines = list.map((p) => `- [${p.server}] ${p.name}${p.description ? ` — ${p.description}` : ''}`);
      return { content: lines.join('\n') };
    },
  };
}
