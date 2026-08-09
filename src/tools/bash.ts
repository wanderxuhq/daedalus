import { spawn } from 'node:child_process';
import type { Tool, ToolContext, ToolResult } from './types.ts';

const BASH_TIMEOUT = 120_000;

export const bashTool: Tool = {
  name: 'bash',
  description: 'Execute a shell command and return its output',
  inputSchema: {
    type: 'object',
    properties: { command: { type: 'string' } },
    required: ['command'],
  },
  async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const command = (input as { command: string }).command;
    const ok = await ctx.askPermission('bash', command);
    if (!ok) return { content: 'Permission denied by user', isError: true };
    return new Promise((resolve) => {
      const child = spawn(command, { shell: true, cwd: ctx.cwd, timeout: BASH_TIMEOUT });
      let stdout = '', stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('error', (e) => resolve({ content: e.message, isError: true }));
      child.on('close', (code) => {
        const out = [stdout, stderr].filter(Boolean).join('\n');
        if (code !== 0) resolve({ content: `exit ${code}\n${out}`, isError: true });
        else resolve({ content: out || '(no output)' });
      });
    });
  },
};
