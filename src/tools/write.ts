import { promises as fs } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import type { Tool, ToolContext, ToolResult } from './types.ts';
import { LockTimeoutError } from '../core/file-lock.ts';
import { unifiedDiff } from './diff.ts';

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
    // Exclusive write lock FIRST, exactly like edit: the existence check AND the
    // /undo snapshot must reflect the state right before our write. Reading
    // before locking is a TOCTOU — between the read and the locked write another
    // agent could create or modify the file, and this write would silently
    // clobber it (and record a stale undo snapshot). Holding the lock across the
    // permission prompt is deliberate: it is what makes the whole
    // read-permission-write atomic against the rest of the team.
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
      // Read once to learn both existence AND the pre-write content (the latter
      // is the /undo snapshot). An unreadable path is treated as absent, exactly
      // like the old fs.access probe.
      let original: string | null = null;
      try {
        original = await fs.readFile(full, 'utf8');
      } catch (e: any) {
        // Only treat ENOENT (file not found) as "absent". Other errors
        // (EACCES, EIO, etc.) are real failures that should be surfaced.
        if (e?.code !== 'ENOENT') {
          return { content: `Failed to read ${full}: ${e.message}`, isError: true };
        }
      }
      if (original !== null) {
        const ok = await ctx.askPermission('write', full);
        if (!ok) return { content: 'Permission denied by user', isError: true };
      }
      await fs.mkdir(dirname(full), { recursive: true });
      await fs.writeFile(full, content, 'utf8');
      // Snapshot after the write succeeded; null original = the file did not
      // exist before, so /undo deletes it.
      ctx.undo?.record(ctx.agent, full, original);
      return { content: `Wrote ${full}`, diff: unifiedDiff(original ?? '', content) };
    } finally {
      release?.();
    }
  },
};
