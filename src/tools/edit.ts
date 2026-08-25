import { promises as fs } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { Tool, ToolContext, ToolResult } from './types.ts';
import { LockTimeoutError } from '../core/file-lock.ts';
import { unifiedDiff } from './diff.ts';

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
    // edit is a read-modify-write: the write lock must cover the WHOLE
    // operation (read + check + write), not just the final write, or two
    // concurrent edits would still lose one update. A lock conflict surfaces as
    // an error result naming the holder.
    let release: (() => void) | null = null;
    if (ctx.locks) {
      try {
        release = await ctx.locks.acquireWrite(full, { holder: ctx.agent ?? 'main' });
      } catch (e) {
        if (e instanceof LockTimeoutError) return { content: (e as Error).message, isError: true };
        throw e;
      }
    }
    try {
      let text: string;
      try {
        text = await fs.readFile(full, 'utf8');
      } catch (e) {
        const error = e as NodeJS.ErrnoException;
        if (error.code === 'ENOENT') {
          return { content: `ENOENT: no such file or directory, edit '${full}'`, isError: true };
        }
        throw e;
      }
      const count = text.split(oldString).length - 1;
      if (count === 0) return { content: `oldString not found in ${full}`, isError: true };
      if (count > 1) return { content: `oldString matches ${count} times; not unique`, isError: true };
      const updated = text.replace(oldString, newString);
      await fs.writeFile(full, updated, 'utf8');
      // Snapshot AFTER the write succeeded (a failed write must not leave an
      // undo entry that restores a state the file never left). The snapshot is
      // the pre-edit text, so /undo returns the file exactly to before.
      ctx.undo?.record(ctx.agent, full, text);
      return { content: `Edited ${full}`, diff: unifiedDiff(text, updated) };
    } finally {
      release?.();
    }
  },
};
