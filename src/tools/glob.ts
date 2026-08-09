import { promises as fs } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { Tool, ToolContext, ToolResult } from './types.ts';

const IGNORE = new Set(['node_modules', '.git']);

export function matchesGlob(pattern: string, str: string): boolean {
  const re = new RegExp(
    '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '__GLOBSTAR__')
      .replace(/\*/g, '[^/]*')
      .replace(/__GLOBSTAR__/g, '.*')
      .replace(/\?/g, '[^/]') + '$',
  );
  return re.test(str);
}

export const globTool: Tool = {
  name: 'glob',
  description: 'Find files matching a glob pattern',
  inputSchema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] },
  async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { pattern, path = '.' } = input as { pattern: string; path?: string };
    const root = isAbsolute(path) ? path : join(ctx.cwd, path);
    const all: string[] = [];
    async function walk(dir: string, rel: string): Promise<void> {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (IGNORE.has(e.name)) continue;
        const relPath = rel ? `${rel}/${e.name}` : e.name;
        const full = join(dir, e.name);
        if (e.isDirectory()) { await walk(full, relPath); continue; }
        all.push(relPath);
      }
    }
    await walk(root, '');
    const matches = all.filter((f) => matchesGlob(pattern, f));
    return { content: matches.join('\n') || '(no matches)' };
  },
};
