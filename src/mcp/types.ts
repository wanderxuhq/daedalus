/** Configuration for a single MCP server (Claude Desktop format). */
export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** Top-level mcp.json shape. */
export interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

/** Connection lifecycle state for a single server. */
export type McpConnectionState = 'connecting' | 'connected' | 'failed';

/** Runtime status of a connected MCP server. */
export interface McpServerStatus {
  name: string;
  state: McpConnectionState;
  toolCount: number;
  resourceCount: number;
  promptCount: number;
  error?: string;
}
