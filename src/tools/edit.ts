import { promises as fs } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { Tool, ToolContext, ToolResult } from './types.ts';

export const editTool: Tool = {
  name: 'edit',
  description: 'Replace an exact string in a file',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' }, oldString: { type: 'string' }, newString: { type: 'string' } },
    required: ['path', 'oldString', 'newString'],
  },
  async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { path, oldString, newString } = input as { path: string; oldString: string; newString: string };
    const full = isAbsolute(path) ? path : join(ctx.cwd, path);
    const text = await fs.readFile(full, 'utf8');
    const count = text.split(oldString).length - 1;
    if (count === 0) return { content: `oldString not found in ${full}`, isError: true };
    if (count > 1) return { content: `oldString matches ${count} times; not unique`, isError: true };
    await fs.writeFile(full, text.replace(oldString, newString), 'utf8');
    return { content: `Edited ${full}` };
  },
};
