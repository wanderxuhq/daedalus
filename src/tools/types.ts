import type { FileLockRegistry } from '../core/file-lock.ts';
import type { FileUndoRegistry } from '../core/undo.ts';

export interface ToolResult {
  content: string;
  isError?: boolean;
  /**
   * Optional unified diff of a file mutation (edit/write). Rendered as a diff
   * card by the CLI; never sent to the model (result blocks only carry content).
   */
  diff?: string;
}
export interface ToolContext {
  cwd: string;
  askPermission: (action: string, target: string) => Promise<boolean>;
  /** Abort signal propagated from the caller (Ctrl+C interrupt of the current turn). */
  signal?: AbortSignal;
  /**
   * Shared writer-preferring file locks, so concurrent agents (the main agent
   * + parallel subagents) don't clobber each other's files. Absent in
   * embedders that opt out — tools then proceed unlocked.
   */
  locks?: FileLockRegistry;
  /** Identity label for the lock holder ('main', a subagent name, …). */
  agent?: string;
  /**
   * Per-agent undo registry: the tools snapshot the pre-mutation content here
   * so `/undo` can restore it. Absent in embedders that opt out.
   */
  undo?: FileUndoRegistry;
}
export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute(input: unknown, ctx: ToolContext): Promise<ToolResult>;
}
