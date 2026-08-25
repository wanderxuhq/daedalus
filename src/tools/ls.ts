import { promises as fs } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { Tool, ToolContext, ToolResult } from './types.ts';
import { truncateResult } from './output.ts';

const IGNORE = new Set(['node_modules', '.git']);

export const lsTool: Tool = {
  name: 'ls',
  description: 'List directory contents',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { path = '.' } = input as { path?: string };
    const full = isAbsolute(path) ? path : join(ctx.cwd, path);
    
    try {
      const entries = await fs.readdir(full, { withFileTypes: true });
      const lines = entries
        .filter((e) => !IGNORE.has(e.name))
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
      const { content } = await truncateResult(lines.join('\n') || '(empty)');
      return { content };
    } catch (e) {
      // Handle common filesystem errors
      const error = e as NodeJS.ErrnoException;
      if (error.code === 'ENOENT') {
        return { content: `ENOENT: no such file or directory, scandir '${full}'`, isError: true };
      }
      if (error.code === 'ENOTDIR') {
        return { content: `ENOTDIR: not a directory, scandir '${full}'`, isError: true };
      }
      if (error.code === 'EACCES') {
        return { content: `EACCES: permission denied, scandir '${full}'`, isError: true };
      }
      // Re-throw other errors
      throw e;
    }
  },
};
