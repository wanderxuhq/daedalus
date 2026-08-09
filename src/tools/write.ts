import { promises as fs } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import type { Tool, ToolContext, ToolResult } from './types.ts';

export const writeTool: Tool = {
  name: 'write',
  description: 'Write content to a file (overwrites after confirmation if it exists)',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' }, content: { type: 'string' } },
    required: ['path', 'content'],
  },
  async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { path, content } = input as { path: string; content: string };
    const full = isAbsolute(path) ? path : join(ctx.cwd, path);
    let exists = false;
    try { await fs.access(full); exists = true; } catch { /* not exists */ }
    if (exists) {
      const ok = await ctx.askPermission('write', full);
      if (!ok) return { content: 'Permission denied by user', isError: true };
    }
    await fs.mkdir(dirname(full), { recursive: true });
    await fs.writeFile(full, content, 'utf8');
    return { content: `Wrote ${full}` };
  },
};
