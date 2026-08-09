import { promises as fs } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { Tool, ToolContext, ToolResult } from './types.ts';

const MAX_BYTES = 1_000_000;

export const readTool: Tool = {
  name: 'read',
  description: 'Read a file, optionally with line offset and limit',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      offset: { type: 'number' },
      limit: { type: 'number' },
    },
    required: ['path'],
  },
  async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { path, offset, limit } = input as { path: string; offset?: number; limit?: number };
    const full = isAbsolute(path) ? path : join(ctx.cwd, path);
    const stat = await fs.stat(full);
    if (stat.size > MAX_BYTES && offset === undefined) {
      return { content: `File is ${stat.size} bytes; too large to read whole. Pass offset/limit.`, isError: true };
    }
    const text = await fs.readFile(full, 'utf8');
    const lines = text.split('\n');
    const start = offset ?? 0;
    const end = limit !== undefined ? start + limit : lines.length;
    const sliced = lines.slice(start, end);
    const isPartial = offset !== undefined || limit !== undefined;
    const content = isPartial ? sliced.map((l, i) => `${start + i + 1}\t${l}`).join('\n') : sliced.join('\n');
    return { content };
  },
};
