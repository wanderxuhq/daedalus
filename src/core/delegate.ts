import type { AiClient } from '../ai/types.ts';
import type { Tool, ToolResult } from '../tools/types.ts';
import { Session } from './session.ts';
import { runAgent } from '../agent/loop.ts';
import { buildSystemPrompt } from './system-prompt.ts';

export interface DelegateToolOptions {
  client: AiClient;
  cwd: string;
  /**
   * Resolve the permission handler at CALL time (not construction time), so a
   * permission handler installed later (e.g. the REPL's y/n prompt via
   * setAskPermission) also guards subagent tool calls.
   */
  askPermission: () => (action: string, target: string) => Promise<boolean>;
  /** Tools a subagent may use. Must NOT include the delegate tool itself — that is what stops recursion. */
  availableTools: Tool[];
  /** Context budget for the subagent's OWN history; trimmed independently of the main session. */
  maxContextTokens?: number;
  /** Extended thinking request forwarded to subagent turns as well. */
  thinking?: import('../ai/types.ts').ThinkingParams;
  /** System prompt for subagents; defaults to {@link buildSubagentPrompt}. */
  subagentSystemPrompt?: string;
}

export interface DelegateInput {
  /** The self-contained task the subagent must complete. */
  task: string;
  /** Optional background the subagent needs (paths, constraints, prior findings). */
  context?: string;
  /** Restrict the subagent to a subset of the built-in tools by name. Default: all built-in tools. */
  tools?: string[];
  /** Cap on subagent tool-call iterations; default is the engine's (or 100). */
  maxIterations?: number;
  /** Cap on the returned report length in characters; default 20_000. */
  maxResultChars?: number;
}

/** Guards against a delegate call that would blow the main context with a giant report. */
const DEFAULT_MAX_RESULT_CHARS = 20_000;
const MISSING_TASK_MSG = 'Missing required "task" — delegate needs a self-contained task for the subagent.';

/**
 * System prompt for subagents: the same professional Daedalus operating rules,
 * plus an explicit "you are a delegated worker" frame so the subagent finishes
 * with a concise report instead of narrating its intermediate steps.
 */
export function buildSubagentPrompt(): string {
  return [
    buildSystemPrompt({ delegate: false }),
    '',
    '# You are a delegated subagent',
    '',
    '- You were spawned by the main Daedalus agent to complete ONE task in isolation. The main agent cannot see your tool calls or intermediate steps.',
    '- Work only from the Context and Task below. Do not assume anything outside them; explore the repository with your tools when you need more.',
    '- Complete the task autonomously — do not ask the caller questions mid-task. If a decision is genuinely blocked, pick the most defensible option and say so in the report.',
    '- Finish with a concise report: what you changed or found, verification you ran, and anything the caller must know. Do not narrate the journey.',
  ].join('\n');
}

/** The `delegate` tool: hand a self-contained task to a fresh subagent with its own context. */
export function createDelegateTool(opts: DelegateToolOptions): Tool {
  return {
    name: 'delegate',
    description:
      'Run a task in a separate subagent with its own isolated context. Use this for large or self-contained work (repository research, refactoring, test-writing, file exploration) so the subagent\'s intermediate tool calls do not pollute your own context. The subagent returns only its final report. The subagent has the built-in tools (never delegate itself, so no recursion) and cannot see your conversation.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The self-contained task for the subagent. Be specific: include paths, acceptance criteria, and what the final report should contain.' },
        context: { type: 'string', description: 'Optional background the subagent needs but cannot see in the main conversation (file paths, constraints, prior findings).' },
        tools: { type: 'array', items: { type: 'string' }, description: 'Optional restriction to a subset of built-in tools (bash, read, write, edit, ls, grep, glob). Default: all.' },
        maxIterations: { type: 'number', description: 'Optional cap on subagent tool-call iterations.' },
        maxResultChars: { type: 'number', description: `Optional cap on report length in characters (default ${DEFAULT_MAX_RESULT_CHARS}).` },
      },
      required: ['task'],
    },
    async execute(input: unknown): Promise<ToolResult> {
      const args = input as Partial<DelegateInput>;
      if (!args.task || typeof args.task !== 'string') {
        return { content: MISSING_TASK_MSG, isError: true };
      }

      // The subagent works from the task text ONLY — never from the main
      // session's history. Its session carries its own system prompt + task.
      const subSession = new Session();
      subSession.start();
      subSession.addMessage({
        role: 'system',
        content: [{ type: 'text', text: opts.subagentSystemPrompt ?? buildSubagentPrompt() }],
      });

      const prompt = [
        args.context ? `# Context\n\n${args.context}\n\n` : '',
        `# Task\n\n${args.task}`,
      ].join('');

      const allowed = args.tools?.length
        ? opts.availableTools.filter((t) => args.tools!.includes(t.name))
        : opts.availableTools;

      try {
        const report = await runAgent({
          client: opts.client,
          session: subSession,
          prompt,
          tools: allowed,
          cwd: opts.cwd,
          askPermission: opts.askPermission(),
          maxIterations: args.maxIterations,
          maxContextTokens: opts.maxContextTokens,
          ...(opts.thinking ? { thinking: opts.thinking } : {}),
        });
        const limit = args.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS;
        const trimmed = report.length > limit
          ? `${report.slice(0, limit)}\n\n…[report truncated: exceeded ${limit} chars]`
          : report;
        return { content: trimmed || '(subagent returned no output)' };
      } catch (e) {
        // A failing subagent is a tool error, not a main-agent crash: surface it
        // as an error result so the main agent sees it and can adapt.
        return { content: `Subagent failed: ${(e as Error).message}`, isError: true };
      }
    },
  };
}
