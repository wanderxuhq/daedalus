import type { Tool } from '../tools/types.ts';
import type { McpConfig, McpServerConfig, McpServerStatus } from './types.ts';
import type { McpConnectionState } from './types.ts';
import { loadMcpConfig } from './config.ts';
import {
  wrapMcpTool,
  createResourceTool,
  createResourceListTool,
  createPromptTool,
  createPromptListTool,
  type McpToolClient,
  type McpResourceReader,
  type McpPromptReader,
} from './tool-adapter.ts';

interface ServerEntry {
  config: McpServerConfig;
  state: McpConnectionState;
  client: McpToolClient | null;
  tools: Tool[];
  resourceCount: number;
  promptCount: number;
  error?: string;
  /** Discovered resources for the resource reader. */
  resources: Array<{ server: string; uri: string; name: string; description?: string }>;
  /** Discovered prompts for the prompt reader. */
  prompts: Array<{ server: string; name: string; description?: string }>;
}

/**
 * Manages the lifecycle of MCP server connections.
 *
 * On start(), connects to all configured servers asynchronously in parallel.
 * Tools, resources, and prompts are discovered lazily per-server as connections
 * succeed. The tool array is rebuilt after each successful connection.
 */
export class McpManager {
  private config: McpConfig;
  private servers = new Map<string, ServerEntry>();
  private allTools: Tool[] = [];
  private resourceTools: Tool[] = [];
  private promptTools: Tool[] = [];
  private disposeControllers = new Map<string, AbortController>();

  constructor(config?: McpConfig) {
    this.config = config ?? { mcpServers: {} };
    for (const [name, cfg] of Object.entries(this.config.mcpServers)) {
      this.servers.set(name, {
        config: cfg,
        state: 'connecting',
        client: null,
        tools: [],
        resourceCount: 0,
        promptCount: 0,
        resources: [],
        prompts: [],
      });
    }
  }

  /**
   * Start connecting to all configured MCP servers in parallel.
   * Non-blocking: connections happen asynchronously.
   */
  start(): void {
    for (const [name, entry] of this.servers) {
      this.connectServer(name, entry).catch(() => { /* errors captured in entry.state */ });
    }
  }

  private async connectServer(name: string, entry: ServerEntry): Promise<void> {
    const ac = new AbortController();
    this.disposeControllers.set(name, ac);

    try {
      // Dynamic import so the optional dependency doesn't break when absent
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

      if (ac.signal.aborted) return;

      const transport = new StdioClientTransport({
        command: entry.config.command,
        args: entry.config.args,
        env: entry.config.env ? { ...process.env as Record<string, string>, ...entry.config.env } : undefined,
      });

      const client = new Client({ name: 'daedalus', version: '0.1.0' });
      await client.connect(transport);

      if (ac.signal.aborted) {
        await client.close().catch(() => {});
        return;
      }

      entry.client = client as unknown as McpToolClient;
      entry.state = 'connected';

      // Discover capabilities
      try {
        const toolsResult = await client.listTools();
        for (const mcpTool of toolsResult.tools) {
          const adapted = wrapMcpTool({ ...mcpTool, description: mcpTool.description ?? mcpTool.name }, name, client as unknown as McpToolClient);
          entry.tools.push(adapted);
        }
      } catch { /* server may not support tools */ }

      try {
        const resourcesResult = await client.listResources();
        for (const res of resourcesResult.resources) {
          entry.resources.push({ server: name, uri: res.uri, name: res.name, description: res.description });
        }
        entry.resourceCount = resourcesResult.resources.length;
      } catch { /* server may not support resources */ }

      try {
        const promptsResult = await client.listPrompts();
        for (const prompt of promptsResult.prompts) {
          entry.prompts.push({ server: name, name: prompt.name, description: prompt.description });
        }
        entry.promptCount = promptsResult.prompts.length;
      } catch { /* server may not support prompts */ }

      this.rebuildToolArrays();
    } catch (e) {
      entry.state = 'failed';
      entry.error = (e as Error).message;
    }
  }

  private rebuildToolArrays(): void {
    // Collect all MCP tools from all connected servers
    this.allTools = [];
    const allResources: McpResourceReader = {
      readResource: async (server, uri) => this.readResource(server, uri),
      getResourceList: () => this.getResourceList(),
    };
    const allPrompts: McpPromptReader = {
      getPrompt: async (server, name, args) => this.getPrompt(server, name, args),
      getPromptList: () => this.getPromptList(),
    };

    for (const entry of this.servers.values()) {
      this.allTools.push(...entry.tools);
    }

    // Build resource tools if any server has resources
    const hasResources = [...this.servers.values()].some((e) => e.resourceCount > 0);
    this.resourceTools = hasResources ? [createResourceTool(allResources), createResourceListTool(allResources)] : [];

    // Build prompt tools if any server has prompts
    const hasPrompts = [...this.servers.values()].some((e) => e.promptCount > 0);
    this.promptTools = hasPrompts ? [createPromptTool(allPrompts), createPromptListTool(allPrompts)] : [];
  }

  /** Get all MCP tools as Daedalus Tool objects. */
  getTools(): Tool[] {
    return this.allTools;
  }

  /** Get MCP resource tools (mcp_read_resource, mcp_list_resources). */
  getResourceTools(): Tool[] {
    return this.resourceTools;
  }

  /** Get MCP prompt tools (mcp_get_prompt, mcp_list_prompts). */
  getPromptTools(): Tool[] {
    return this.promptTools;
  }

  /** Get connection status for all configured servers. */
  getStatus(): McpServerStatus[] {
    return [...this.servers.entries()].map(([name, entry]) => ({
      name,
      state: entry.state,
      toolCount: entry.tools.length,
      resourceCount: entry.resourceCount,
      promptCount: entry.promptCount,
      ...(entry.error ? { error: entry.error } : {}),
    }));
  }

  /** Read a resource from a specific server. */
  async readResource(server: string, uri: string): Promise<{ contents: Array<{ uri: string; text?: string; blob?: string }> }> {
    const entry = this.servers.get(server);
    if (!entry || !entry.client) throw new Error(`MCP server "${server}" is not connected`);
    const client = entry.client as unknown as import('./tool-adapter.ts').McpResourceClient;
    return client.readResource({ uri });
  }

  /** Get a list of all resources across all servers. */
  getResourceList(): Array<{ server: string; uri: string; name: string; description?: string }> {
    const list: Array<{ server: string; uri: string; name: string; description?: string }> = [];
    for (const entry of this.servers.values()) {
      list.push(...entry.resources);
    }
    return list;
  }

  /** Get a prompt from a specific server. */
  async getPrompt(server: string, name: string, args?: Record<string, string>): Promise<{ messages: Array<{ role: string; content: { type: string; text?: string } }> }> {
    const entry = this.servers.get(server);
    if (!entry || !entry.client) throw new Error(`MCP server "${server}" is not connected`);
    const client = entry.client as unknown as import('./tool-adapter.ts').McpPromptClient;
    return client.getPrompt({ name, arguments: args });
  }

  /** Get a list of all prompts across all servers. */
  getPromptList(): Array<{ server: string; name: string; description?: string }> {
    const list: Array<{ server: string; name: string; description?: string }> = [];
    for (const entry of this.servers.values()) {
      list.push(...entry.prompts);
    }
    return list;
  }

  /** Shutdown all server connections. */
  async dispose(): Promise<void> {
    // Abort any in-flight connections
    for (const ac of this.disposeControllers.values()) ac.abort();
    this.disposeControllers.clear();

    // Close connected clients
    for (const entry of this.servers.values()) {
      if (entry.client) {
        try {
          await (entry.client as unknown as { close(): Promise<void> }).close();
        } catch { /* best effort */ }
        entry.client = null;
      }
    }
  }
}
