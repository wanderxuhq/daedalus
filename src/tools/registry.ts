import { createBashTool } from './bash.ts';
import { readTool } from './read.ts';
import { writeTool } from './write.ts';
import { editTool } from './edit.ts';
import { lsTool } from './ls.ts';
import { grepTool } from './grep.ts';
import { globTool } from './glob.ts';
import type { Tool } from './types.ts';
import type { ShellRegistry } from './shell.ts';

/**
 * The seven builtin tools. bash is the only stateful one — it needs the
 * per-agent shell registry (persistent cwd/env), so the whole set is built by
 * a factory. The registry is engine-scoped: main agent + each named subagent
 * get their own shell, and all shells die on engine.dispose().
 */
export function createTools(shells: ShellRegistry): Tool[] {
  return [createBashTool(shells), readTool, writeTool, editTool, lsTool, grepTool, globTool];
}

/**
 * File-mutating tools removed in plan mode (read-only exploration). bash stays
 * available — the user's permission prompts gate anything destructive — but
 * write/edit are simply absent so the agent cannot silently change files.
 */
export const PLAN_BLOCKED_TOOLS = new Set(['write', 'edit']);
