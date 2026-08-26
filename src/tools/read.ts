import { createReadStream, promises as fs } from 'node:fs';
import { createInterface } from 'node:readline';
import { isAbsolute, join } from 'node:path';
import type { Tool, ToolContext, ToolResult } from './types.ts';
import { truncateResult } from './output.ts';
import { LockTimeoutError } from '../core/file-lock.ts';

const MAX_BYTES = 1_000_000;

/**
 * Stream lines [start, end) straight from disk — the file is never read into
 * memory whole, so offset/limit reads are safe even on multi-GB files.
 * Whole reads (no offset/limit) are still guarded by MAX_BYTES.
 */
async function readLines(full: string, start: number, end: number): Promise<string[]> {
  const rs = createReadStream(full);
  const rl = createInterface({ input: rs, crlfDelay: Infinity });
  const lines: string[] = [];
  let i = 0;
  try {
    for await (const line of rl) {
      if (i >= end) break;
      if (i >= start) lines.push(line);
      i++;
    }
  } finally {
    rl.close();
    // rl.close() stops readline but leaves the underlying file stream (and its
    // fd) open; an early break on a huge file must destroy it or partial reads
    // accumulate open file descriptors over a long session.
    rs.destroy();
  }
  return lines;
}

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
    // Shared read lock: parallel reads of the same file stay concurrent; only a
    // writer (write/edit elsewhere in the team) blocks this read. A lock
    // conflict surfaces as an error result for the model to arbitrate.
    let release: (() => void) | null = null;
    if (ctx.locks) {
      try {
        release = await ctx.locks.acquireRead(full, { holder: ctx.agent ?? 'main' });
      } catch (e) {
        if (e instanceof LockTimeoutError) return { content: (e as Error).message, isError: true };
        throw e;
      }
    }
    try {
      let stat;
      try {
        stat = await fs.stat(full);
      } catch (e) {
        const error = e as NodeJS.ErrnoException;
        if (error.code === 'ENOENT') {
          return { content: `ENOENT: no such file or directory, stat '${full}'`, isError: true };
        }
        throw e;
      }
      
      if (stat.isDirectory()) {
        return { content: `EISDIR: illegal operation on a directory, read '${full}'`, isError: true };
      }
      
      if (stat.size > MAX_BYTES && offset === undefined) {
        return { content: `File is ${stat.size} bytes; too large to read whole. Pass offset/limit.`, isError: true };
      }
      const start = offset ?? 0;
      const end = limit !== undefined ? start + limit : Number.POSITIVE_INFINITY;
      const sliced = await readLines(full, start, end);
      const isPartial = offset !== undefined || limit !== undefined;
      const startLine = offset ?? 0;
      // Always prefix lines with line numbers for the web UI code view.
      const content = sliced.map((l, i) => `${startLine + i + 1}\t${l}`).join('\n');
      // Guard against one enormous line / 2k-line reads blowing the window: same
      // truncate-and-spill policy as bash.
      const { content: capped } = await truncateResult(content);
      return { content: capped };
    } finally {
      release?.();
    }
  },
};
