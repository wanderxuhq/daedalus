import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { McpConfig } from './types.ts';

const DEFAULT_MCP_PATH = join(homedir(), '.daedalus', 'mcp.json');

/**
 * Load MCP server configuration from a JSON file.
 * Returns an empty object on any error (file missing, invalid JSON, missing mcpServers key).
 */
export function loadMcpConfig(configPath?: string): McpConfig {
  const path = configPath ?? DEFAULT_MCP_PATH;
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && 'mcpServers' in parsed && typeof parsed.mcpServers === 'object') {
      return parsed as McpConfig;
    }
    return { mcpServers: {} };
  } catch {
    return { mcpServers: {} };
  }
}
