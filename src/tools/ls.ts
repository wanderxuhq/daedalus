import { promises as fs } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { Tool, ToolContext, ToolResult } from './types.ts';

const IGNORE = new Set(['node_modules', '.git']);

export const lsTool: Tool = {
  name: 'ls',
  description: 'List directory contents',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { path = '.' } = input as { path?: string };
    const full = isAbsolute(path) ? path : join(ctx.cwd, path);
    const entries = await fs.readdir(full, { withFileTypes: true });
    const lines = entries
      .filter((e) => !IGNORE.has(e.name))
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
    return { content: lines.join('\n') || '(empty)' };
  },
};
