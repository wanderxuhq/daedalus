import type { Tool, ToolContext, ToolResult } from './types.ts';
import { truncateResult } from './output.ts';
import { ShellRegistry } from './shell.ts';

/**
 * A factory, not a singleton: bash needs the per-agent {@link ShellRegistry}
 * (one long-lived shell per agent, so `cd`/`export` persist across calls).
 * Engine-level layering constructs one instance and shares it — the same Tool
 * instance serves the main agent and every subagent, dispatching per
 * `ctx.agent` inside the registry.
 */

/** Maximum command length to prevent accidental context window overflow. */
const MAX_COMMAND_LENGTH = 100_000;

export function createBashTool(shells: ShellRegistry): Tool {
  return {
    name: 'bash',
    description: 'Run a shell command in a persistent shell: the working directory and exported environment variables persist between calls. Commands may be multi-line scripts. Interactive programs (vim, htop) have no TTY and will fail; use the 2-minute timeout for anything slow.',
    inputSchema: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
    async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
      // ── Input validation ────────────────────────────────────────────────
      if (input === null || input === undefined || typeof input !== 'object') {
        return {
          content: 'bash: invalid input — expected an object with a "command" string property',
          isError: true,
        };
      }
      if (!('command' in (input as Record<string, unknown>))) {
        return {
          content: 'bash: missing required "command" property — pass the shell command to execute',
          isError: true,
        };
      }
      const { command: raw } = input as Record<string, unknown>;
      if (typeof raw !== 'string') {
        return {
          content: `bash: "command" must be a string, got ${typeof raw}`,
          isError: true,
        };
      }
      const command = raw.trim();
      if (command.length === 0) {
        return {
          content: 'bash: command is empty — pass a non-empty shell command',
          isError: true,
        };
      }
      if (command.length > MAX_COMMAND_LENGTH) {
        return {
          content: `bash: command too long (${command.length} chars, max ${MAX_COMMAND_LENGTH}) — shorten the command or write it to a file and source it`,
          isError: true,
        };
      }
      // ── Permission gate ──────────────────────────────────────────────────
      const ok = await ctx.askPermission('bash', command);
      if (!ok) return { content: 'Permission denied by user', isError: true };
      // ── Execute ──────────────────────────────────────────────────────────
      const shell = shells.get(ctx.agent);
      try {
        const res = await shell.run(command, ctx.signal ? { signal: ctx.signal } : {});
        // CC-style: never let a huge command dump blow the context window —
        // truncate and spill the full output to a temp file the model can read.
        const { content } = await truncateResult(res.output || (res.code !== 0 ? '' : '(no output)'));
        if (res.code !== 0) return { content: `exit ${res.code}\n${content}`, isError: true };
        return { content };
      } catch (e) {
        const err = e as Error;
        // ShellTimeoutError and ShellCancelledError already carry descriptive
        // messages; enrich any other unexpected error with the command for
        // debugging context.
        const msg = err.name === 'ShellTimeoutError' || err.name === 'ShellCancelledError'
          ? err.message
          : `bash: ${err.message}`;
        return { content: msg, isError: true };
      }
    },
  };
}
