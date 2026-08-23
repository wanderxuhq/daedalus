import { promises as fs } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { Tool, ToolContext, ToolResult } from './types.ts';
import { truncateResult } from './output.ts';
import { GitignoreMatcher, isIgnored, type IgnoreLayer } from './gitignore.ts';

const ALWAYS_IGNORED = new Set(['node_modules', '.git']);
/** Files bigger than this are skipped — grepping them into context is never useful. */
const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** Cap on reported matches; refine the pattern rather than flooding context. */
const MAX_MATCHES = 500;

function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8192).includes(0);
}

export const grepTool: Tool = {
  name: 'grep',
  description: 'Recursively search file contents for a pattern (respects .gitignore, skips binary/large files)',
  inputSchema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] },
  async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { pattern, path = '.' } = input as { pattern: string; path?: string };
    const re = new RegExp(pattern);
    const root = isAbsolute(path) ? path : join(ctx.cwd, path);
    const out: string[] = [];
    let matchCount = 0;
    let truncated = false;
    const stack: IgnoreLayer[] = [];

    async function walk(dir: string, rel: string): Promise<void> {
      // Load this directory's .gitignore (if any) onto the layer stack. Only pop
      // when a layer was actually pushed (a child dir without .gitignore must not
      // drop its parent's rules for sibling entries).
      let pushed = false;
      try {
        const gi = await fs.readFile(join(dir, '.gitignore'), 'utf8');
        const matcher = new GitignoreMatcher();
        matcher.addContent(gi);
        stack.push({ base: rel, matcher });
        pushed = true;
      } catch { /* no .gitignore here */ }

      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (ALWAYS_IGNORED.has(e.name)) continue;
        const full = join(dir, e.name);
        const relPath = rel ? `${rel}/${e.name}` : e.name;
        const isDir = e.isDirectory();
        if (isIgnored(stack, relPath, isDir)) continue; // ripgrep-style: skip ignored paths
        if (isDir) { await walk(full, relPath); continue; }
        if (matchCount >= MAX_MATCHES) { truncated = true; continue; }

        let buf: Buffer;
        try {
          buf = await fs.readFile(full);
        } catch { continue; }
        if (buf.length > MAX_FILE_BYTES || looksBinary(buf)) continue; // binary/large → skip
        const lines = buf.toString('utf8').split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (matchCount >= MAX_MATCHES) { truncated = true; break; }
          if (re.test(lines[i])) {
            out.push(`${full}:${i + 1}:${lines[i]}`);
            matchCount++;
          }
        }
      }
      if (pushed) stack.pop();
    }

    await walk(root, '');
    const body = out.join('\n');
    const note = truncated ? `\n[stopped at ${MAX_MATCHES} matches — refine the pattern]` : '';
    const { content } = await truncateResult(body ? `${body}${note}` : '(no matches)');
    return { content };
  },
};
