export interface ToolResult { content: string; isError?: boolean }
export interface ToolContext { cwd: string; askPermission: (action: string, target: string) => Promise<boolean> }
export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute(input: unknown, ctx: ToolContext): Promise<ToolResult>;
}
