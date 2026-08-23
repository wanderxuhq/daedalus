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
      const command = (input as { command: string }).command;
      const ok = await ctx.askPermission('bash', command);
      if (!ok) return { content: 'Permission denied by user', isError: true };
      const shell = shells.get(ctx.agent);
      try {
        const res = await shell.run(command, ctx.signal ? { signal: ctx.signal } : {});
        // CC-style: never let a huge command dump blow the context window —
        // truncate and spill the full output to a temp file the model can read.
        const { content } = await truncateResult(res.output || (res.code !== 0 ? '' : '(no output)'));
        if (res.code !== 0) return { content: `exit ${res.code}\n${content}`, isError: true };
        return { content };
      } catch (e) {
        // Cancellation (Ctrl+C) degrades to a tool error like the old spawn
        // path did; the loop's abort signal then cancels the next model request.
        return { content: (e as Error).message, isError: true };
      }
    },
  };
}
