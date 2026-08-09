import { promises as fs } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { Tool, ToolContext, ToolResult } from './types.ts';

const IGNORE = new Set(['node_modules', '.git']);

export const grepTool: Tool = {
  name: 'grep',
  description: 'Recursively search file contents for a pattern',
  inputSchema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] },
  async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { pattern, path = '.' } = input as { pattern: string; path?: string };
    const re = new RegExp(pattern);
    const root = isAbsolute(path) ? path : join(ctx.cwd, path);
    const out: string[] = [];
    async function walk(dir: string): Promise<void> {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (IGNORE.has(e.name)) continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) { await walk(full); continue; }
        const text = await fs.readFile(full, 'utf8').catch(() => '');
        const lines = text.split('\n');
        lines.forEach((ln, i) => { if (re.test(ln)) out.push(`${full}:${i + 1}:${ln}`); });
      }
    }
    await walk(root);
    return { content: out.join('\n') || '(no matches)' };
  },
};
