import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import type { FileLockRegistry } from './file-lock.ts';

export interface UndoEntry {
  /** Absolute path of the file that was mutated. */
  path: string;
  /** File content before the mutation; `null` when the file did not exist (the mutation created it). */
  original: string | null;
}

/**
 * Per-agent undo stack for file mutations (edit/write). The edit/write tools
 * snapshot the pre-mutation content BEFORE the mutation is recorded, and the
 * REPL's `/undo` pops the main agent's latest snapshot and writes it back.
 *
 * Design notes:
 * - In-memory only, like the file locks: snapshots live for the engine's
 *   lifetime and die with it. This deliberately does NOT depend on git — it
 *   works in non-git projects, never touches the working tree's uncommitted
 *   state, and has no race with a subagent's parallel edits (each agent keeps
 *   its own stack, and the restore takes the shared write lock).
 * - A `null` original means the mutation created the file; undoing deletes it.
 * - Stack depth is capped per agent (oldest snapshots fall off first).
 */
export class FileUndoRegistry {
  private stacks = new Map<string, UndoEntry[]>();
  private readonly capacity: number;

  constructor(capacity = 50) {
    this.capacity = capacity;
  }

  private key(agent?: string): string {
    return agent ?? 'main';
  }

  /** Record a mutation: `original` is the file's content before it changed. */
  record(agent: string | undefined, path: string, original: string | null): void {
    const key = this.key(agent);
    const stack = this.stacks.get(key) ?? [];
    stack.push({ path, original });
    if (stack.length > this.capacity) stack.shift();
    this.stacks.set(key, stack);
  }

  /**
   * Restore an agent's most recent mutation: writes the pre-mutation content
   * back (or deletes a file the mutation created). Holds the shared write lock
   * for the restore so it cannot race a concurrent agent write. Returns the
   * restored entry, or undefined when the stack is empty.
   */
  async undo(agent: string | undefined, locks?: FileLockRegistry): Promise<UndoEntry | undefined> {
    const stack = this.stacks.get(this.key(agent));
    // Peek, don't pop: if acquiring the write lock fails (timeout) the snapshot
    // must stay on the stack, or a later /undo silently restores an OLDER edit.
    const entry = stack?.[stack.length - 1];
    if (!entry) return undefined;
    let release: (() => void) | null = null;
    if (locks) {
      release = await locks.acquireWrite(entry.path, { holder: 'undo' });
    }
    stack.pop();
    try {
      if (entry.original === null) {
        await fs.rm(entry.path, { force: true });
      } else {
        await fs.mkdir(dirname(entry.path), { recursive: true });
        await fs.writeFile(entry.path, entry.original, 'utf8');
      }
    } catch (e) {
      // The restore failed but the mutation still exists — keep the snapshot so
      // a retry can pick it up instead of losing it.
      stack.push(entry);
      throw e;
    } finally {
      release?.();
    }
    return entry;
  }

  /** Drop every agent's stack (engine dispose). */
  clear(): void {
    this.stacks.clear();
  }

  /** Total number of recorded mutations across all agents. */
  get size(): number {
    let n = 0;
    for (const s of this.stacks.values()) n += s.length;
    return n;
  }
}
