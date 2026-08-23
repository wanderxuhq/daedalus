import type { AiClient } from '../ai/types.ts';
import type { Tool, ToolContext, ToolResult } from '../tools/types.ts';
import { Session, SessionPool } from './session.ts';
import { runAgent } from '../agent/loop.ts';
import { buildSystemPrompt, BUILTIN_TOOL_NAMES, DELEGATE_TOOL_NAME, DELEGATE_MANY_TOOL_NAME } from './system-prompt.ts';
import { isCancellationError, AiError } from '../ai/errors.ts';
import type { CoreEvent } from './events.ts';
import type { FileLockRegistry } from './file-lock.ts';
import type { FileUndoRegistry } from './undo.ts';
import { PLAN_BLOCKED_TOOLS } from '../tools/registry.ts';

export interface DelegateToolOptions {
  client: AiClient;
  cwd: string;
  /**
   * Resolve the permission handler at CALL time (not construction time), so a
   * permission handler installed later (e.g. the REPL's y/n prompt via
   * setAskPermission) also guards subagent tool calls.
   */
  askPermission: () => (action: string, target: string) => Promise<boolean>;
  /** Base tools a subagent may use. Must NOT include delegate tools themselves. */
  availableTools: Tool[];
  /** Context budget for the subagent's OWN history; trimmed independently of the main session. */
  maxContextTokens?: number;
  /** Extended thinking request forwarded to subagent turns as well. */
  thinking?: import('../ai/types.ts').ThinkingParams;
  /** System prompt for subagents; defaults to {@link buildSubagentPrompt}. */
  subagentSystemPrompt?: string;
  /** Durable project memory (DAEDALUS.md text) injected into the subagent's system prompt. */
  memory?: string;
  /**
   * How many delegation levels are allowed. `1` (default) = subagents cannot
   * delegate further; `2` = subagents may spawn their own subagents, and so on.
   * The depth cap — not the absence of the tool — is what stops infinite recursion.
   */
  maxDepth?: number;
  /** Pool of named subagent sessions; a delegate call with the same `agent` continues that agent's previous history. */
  sessions?: SessionPool;
  /** Receive the subagent's progress events (text deltas, tool results, …) forwarded from its session. */
  onEvent?: (ev: CoreEvent) => void;
  /** Shared file locks so parallel subagents don't clobber each other's files. */
  locks?: FileLockRegistry;
  /** Shared per-agent undo registry: a subagent's edits are snapshotted under its own agent name. */
  undo?: FileUndoRegistry;
  /** Live plan-mode flag; when true the subagent's toolset drops write/edit too. */
  planMode?: () => boolean;
  /** Track subagent lifecycle: called when a subagent starts running (background mode). */
  onSubagentStart?: (name: string) => void;
  /** Track subagent lifecycle: called when a subagent finishes (background mode). */
  onSubagentEnd?: (name: string) => void;
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
  /** Named identity for session reuse: repeated calls with the same agent continue the same subagent history (requires a session pool). */
  agent?: string;
  /** Instruct the subagent to return its report as a single valid JSON value (parsed by the caller). */
  json?: boolean;
  /** Retry the whole subagent run this many times after a failure (default 0). */
  retries?: number;
  /** Run the subagent in the background without blocking the main agent. Default: false (foreground). */
  background?: boolean;
}

export interface DelegateManyInput {
  /** Independent tasks to fan out to parallel subagents, each a {@link DelegateInput}. */
  tasks: DelegateInput[];
  /** Max number of subagents running at once. Default 3. */
  maxConcurrent?: number;
}

/** Guards against a delegate call that would blow the main context with a giant report. */
const DEFAULT_MAX_RESULT_CHARS = 20_000;
const DEFAULT_MAX_CONCURRENT = 3;
const MISSING_TASK_MSG = 'Missing required "task" — delegate needs a self-contained task for the subagent.';
const MANY_EMPTY_MSG = 'delegateMany requires a non-empty "tasks" array of self-contained subagent tasks.';

/**
 * System prompt for subagents: the same professional Daedalus operating rules,
 * plus an explicit "you are a delegated worker" frame so the subagent finishes
 * with a concise report instead of narrating its intermediate steps.
 */
export function buildSubagentPrompt(opts: { json?: boolean; tools?: string[]; memory?: string } = {}): string {
  return [
    // The subagent's real toolset. By default the seven builtins and nothing
    // else (no Skill, no delegate) — matches availableTools exactly, so the
    // prompt never advertises a tool the subagent does not have. When nesting
    // is enabled the caller passes the delegate tools too.
    buildSystemPrompt({ tools: opts.tools ?? [...BUILTIN_TOOL_NAMES], memory: opts.memory }),
    '',
    '# You are a delegated subagent',
    '',
    '- You were spawned by the main Daedalus agent to complete a task in isolation. The main agent cannot see your tool calls or intermediate steps.',
    '- Work only from the Context and Task below. Do not assume anything outside them; explore the repository with your tools when you need more.',
    '- The user may send you additional messages during your work. These will appear as new user messages in your conversation. Incorporate them into your work as needed.',
    '- Complete the task autonomously — do not ask the caller questions mid-task. If a decision is genuinely blocked, pick the most defensible option and say so in the report.',
    '- Finish with a concise report: what you changed or found, verification you ran, and anything the caller must know. Do not narrate the journey.',
    ...(opts.json
      ? [
          '',
          '# Report format: JSON',
          '',
          '- Your final report MUST be a single valid JSON value — an object or an array. No markdown code fences and no prose before or after it; the caller parses it directly.',
        ]
      : []),
  ].join('\n');
}

/**
 * One subagent run: (re)uses a session, injects the task, and drives the shared
 * agent loop. The session is brand-new unless `opts.sessions` + `args.agent`
 * reuse a pooled session. The abort signal from the caller's turn is forwarded
 * so Ctrl+C interrupts subagents too.
 */
async function runOnce(opts: DelegateToolOptions, depth: number, args: DelegateInput, ctx: ToolContext): Promise<string> {
  const maxDepth = Math.max(1, opts.maxDepth ?? 1);
  const nested = depth + 1 < maxDepth;
  // The subagent works from the task text ONLY — never from the main session's
  // history. Its session carries its own system prompt + task; with a pool and
  // a stable `agent` name, the same subagent keeps its own history across calls.
  let subSession: Session;
  if (opts.sessions && args.agent) {
    subSession = opts.sessions.get(args.agent);
  } else {
    subSession = new Session();
    subSession.start();
  }
  if (subSession.getMessages().length === 0) {
    const tools = nested ? [...BUILTIN_TOOL_NAMES, DELEGATE_TOOL_NAME, DELEGATE_MANY_TOOL_NAME] : [...BUILTIN_TOOL_NAMES];
    subSession.addMessage({
      role: 'system',
      content: [{ type: 'text', text: opts.subagentSystemPrompt ?? buildSubagentPrompt({ json: args.json, tools, memory: opts.memory }) }],
    });
  }

  const prompt = [
    args.context ? `# Context\n\n${args.context}\n\n` : '',
    `# Task\n\n${args.task}`,
  ].join('');

  let allowed = args.tools?.length
    ? opts.availableTools.filter((t) => args.tools!.includes(t.name))
    : opts.availableTools;
  // Plan mode is inherited by subagents: drop write/edit so exploration stays
  // read-only end to end, even through delegation.
  if (opts.planMode?.()) allowed = allowed.filter((t) => !PLAN_BLOCKED_TOOLS.has(t.name));
  // Nested delegation: while this level still has depth budget, hand the
  // subagent its own delegate/delegateMany tools (fresh instances bound one
  // level deeper). The depth cap is the recursion guard.
  if (nested) {
    allowed = [...allowed, createDelegateTool(opts, depth + 1), createDelegateManyTool(opts, depth + 1)];
  }

  const unsub = opts.onEvent
    ? subSession.bus.subscribe((ev) => opts.onEvent!({ ...ev, agent: args.agent }))
    : undefined;
  try {
    return await runAgent({
      client: opts.client,
      session: subSession,
      prompt,
      tools: allowed,
      cwd: opts.cwd,
      askPermission: opts.askPermission(),
      maxIterations: args.maxIterations,
      maxContextTokens: opts.maxContextTokens,
      ...(opts.thinking ? { thinking: opts.thinking } : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      ...(opts.locks ? { locks: opts.locks } : {}),
      ...(opts.undo ? { undo: opts.undo } : {}),
      ...(args.agent ? { agent: args.agent } : { agent: 'subagent' }),
    });
  } finally {
    unsub?.();
  }
}

function trimReport(report: string, maxResultChars: number): string {
  const trimmed = report.length > maxResultChars
    ? `${report.slice(0, maxResultChars)}\n\n…[report truncated: exceeded ${maxResultChars} chars]`
    : report;
  return trimmed || '(subagent returned no output)';
}

/**
 * Run a subagent with retry/error policy: cancellation propagates (it is the
 * caller's interrupt, not a subagent failure); other failures retry up to
 * `retries` times, then degrade to an error tool result instead of crashing.
 */
async function runSubagent(opts: DelegateToolOptions, depth: number, input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const args = input as Partial<DelegateInput>;
  if (!args.task || typeof args.task !== 'string') {
    return { content: MISSING_TASK_MSG, isError: true };
  }
  const retries = Math.max(0, args.retries ?? 0);
  for (let attempt = 0; ; attempt++) {
    try {
      const report = await runOnce(opts, depth, args as DelegateInput, ctx);
      return { content: trimReport(report, args.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS) };
    } catch (e) {
      // Ctrl+C / engine abort is not a subagent failure: propagate so the
      // caller (REPL) treats it as an interrupt, not as a failed tool call.
      if (isCancellationError(e)) throw e;
      if (attempt < retries) continue;
      return { content: `Subagent failed: ${(e as Error).message}`, isError: true };
    }
  }
}

/** The `delegate` tool: hand a self-contained task to a fresh subagent with its own context. */
export function createDelegateTool(opts: DelegateToolOptions, depth = 0): Tool {
  return {
    name: DELEGATE_TOOL_NAME,
    description:
      'Run a task in a separate subagent with its own isolated context. Use this for large or self-contained work (repository research, refactoring, test-writing, file exploration) so the subagent\'s intermediate tool calls do not pollute your own context. The subagent returns only its final report. The subagent cannot see your conversation. Use background:true for long-running tasks that do not block the main conversation. Delegation depth is capped by configuration (by default subagents cannot delegate further, so no recursion).',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The self-contained task for the subagent. Be specific: include paths, acceptance criteria, and what the final report should contain.' },
        context: { type: 'string', description: 'Optional background the subagent needs but cannot see in the main conversation (file paths, constraints, prior findings).' },
        tools: { type: 'array', items: { type: 'string' }, description: 'Optional restriction to a subset of built-in tools (bash, read, write, edit, ls, grep, glob). Default: all.' },
        maxIterations: { type: 'number', description: 'Optional cap on subagent tool-call iterations.' },
        maxResultChars: { type: 'number', description: `Optional cap on report length in characters (default ${DEFAULT_MAX_RESULT_CHARS}).` },
        agent: { type: 'string', description: 'Named identity for session reuse: repeated delegate calls with the same agent continue the same subagent history (requires a session pool).' },
        json: { type: 'boolean', description: 'Ask the subagent to return its report as a single valid JSON value, parsed directly by the caller.' },
        retries: { type: 'number', description: 'Retry the whole subagent run this many times after a failure (default 0).' },
        background: { type: 'boolean', description: 'Run the subagent in the background without blocking the main agent. Default: false (foreground blocks until done). When true, the subagent runs independently, the user can send it messages, and it notifies when complete via WebSocket events.' },
      },
      required: ['task'],
    },
    async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
      const args = input as Partial<DelegateInput>;
      // Generate a default agent name if not provided, so EventHub can track it.
      const agentName = args.agent ?? `subagent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      // Inject the generated name into args so runSubagent/runOnce use it for session and events.
      const enrichedInput = { ...args, agent: agentName };
      opts.onEvent?.({ type: 'delegate_start', agent: agentName, task: args.task ?? '' });
      if (args.background) {
        // Background mode: spawn subagent and return immediately without blocking
        // Track as running so injectSubagentMessage doesn't duplicate the loop
        opts.onSubagentStart?.(agentName);
        runSubagent(opts, depth, enrichedInput, ctx).then(() => {
          opts.onSubagentEnd?.(agentName);
        }).catch((err) => {
          opts.onSubagentEnd?.(agentName);
          // Emit error event for background subagent failures
          const aiErr = err instanceof AiError ? err : new AiError('server', (err as Error).message);
          opts.onEvent?.({ type: 'error', agent: agentName, error: aiErr });
        });
        return { content: `Subagent started: ${agentName}\nTask: ${args.task}` };
      }
      return runSubagent(opts, depth, enrichedInput, ctx);
    },
  };
}

/**
 * The `delegateMany` tool: fan out independent tasks to parallel subagents and
 * merge their final reports into one result. Partial failure degrades to a
 * merged result that marks the failed lanes — the whole call fails only when
 * every lane fails. Each lane runs in its own isolated session, exactly like a
 * single `delegate` call.
 */
export function createDelegateManyTool(opts: DelegateToolOptions, depth = 0): Tool {
  return {
    name: DELEGATE_MANY_TOOL_NAME,
    description:
      'Fan out several INDEPENDENT tasks to parallel subagents, each in its own isolated context, and merge their final reports into one result. Use it when several investigations can proceed concurrently (e.g. explore two areas at once). Pass maxConcurrent to cap parallelism (default 3). Do not use it for tasks that depend on each other or share mutable state — those belong in one delegate call.',
    inputSchema: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              task: { type: 'string', description: 'The self-contained task for this subagent.' },
              context: { type: 'string', description: 'Optional background for this subagent.' },
              tools: { type: 'array', items: { type: 'string' }, description: 'Optional restriction to a subset of built-in tools.' },
              maxIterations: { type: 'number', description: 'Optional cap on this subagent\'s tool-call iterations.' },
              maxResultChars: { type: 'number', description: `Optional cap on this lane's report length (default ${DEFAULT_MAX_RESULT_CHARS}).` },
              agent: { type: 'string', description: 'Named identity for session reuse. Avoid reusing the same agent across parallel lanes — lanes write their sessions concurrently.' },
              json: { type: 'boolean', description: 'Ask this subagent to return its report as a single valid JSON value.' },
              retries: { type: 'number', description: 'Retry this lane this many times after a failure (default 0).' },
              background: { type: 'boolean', description: 'Run this subagent in the background without blocking. Default: false.' },
            },
            required: ['task'],
          },
          description: 'The independent tasks to run in parallel.',
        },
        maxConcurrent: { type: 'number', description: `Max number of subagents running at once (default ${DEFAULT_MAX_CONCURRENT}).` },
      },
      required: ['tasks'],
    },
    async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
      const args = input as Partial<DelegateManyInput>;
      if (!Array.isArray(args.tasks) || args.tasks.length === 0) {
        return { content: MANY_EMPTY_MSG, isError: true };
      }
      // Capture into a const: the Array.isArray narrowing above does not survive
      // into the worker closures for a mutable property, so it must be captured once.
      const tasks = args.tasks;
      const maxConcurrent = Math.max(1, args.maxConcurrent ?? DEFAULT_MAX_CONCURRENT);
      const results = new Array<ToolResult>(tasks.length);
      let next = 0;
      const worker = async (): Promise<void> => {
        while (next < tasks.length) {
          const i = next++;
          const lane = tasks[i] as Partial<DelegateInput>;
          // Generate a default agent name if not provided, so EventHub can track it.
          const laneAgent = lane.agent ?? `subagent-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}`;
          const enrichedLane = { ...lane, agent: laneAgent };
          opts.onEvent?.({ type: 'delegate_start', agent: laneAgent, task: lane.task ?? '' });
          results[i] = await runSubagent(opts, depth, enrichedLane, ctx);
        }
      };
      await Promise.all(Array.from({ length: Math.min(maxConcurrent, args.tasks.length) }, () => worker()));
      const failedCount = results.filter((r) => r.isError).length;
      const parts = results.map((r, i) => `## Subagent ${i + 1}${r.isError ? ' (failed)' : ''}\n\n${r.content}`);
      return {
        content: parts.join('\n\n---\n\n'),
        // Partial results are still valuable: only a total failure is an error.
        isError: failedCount === results.length,
      };
    },
  };
}
