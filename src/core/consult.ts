import type { AiClient, ContentBlock, Message, ThinkingParams } from '../ai/types.ts';
import type { Tool, ToolContext, ToolResult } from '../tools/types.ts';
import { Session } from './session.ts';
import { runAgent } from '../agent/loop.ts';
import type { CoreEvent } from './events.ts';
import type { FileLockRegistry } from './file-lock.ts';
import type { FileUndoRegistry } from './undo.ts';
import { PLAN_BLOCKED_TOOLS } from '../tools/registry.ts';

export const CONSULT_TOOL_NAME = 'consult';
/** Consult is a question-answer task, not a work loop: cap iterations by default. */
const DEFAULT_CONSULT_MAX_ITERATIONS = 10;

export interface ConsultToolOptions {
  client: AiClient;
  cwd: string;
  /** Resolve the permission handler at CALL time, same pattern as delegate. */
  askPermission: () => (action: string, target: string) => Promise<boolean>;
  /** Tools the clone may use (builtins only — never delegate, so no recursion). */
  availableTools: Tool[];
  /** Context budget for the clone's own run (independent of the source session). */
  maxContextTokens?: number;
  /** Session-level model override forwarded to the clone. */
  model?: string;
  /** Extended thinking forwarded to the clone's turns too. */
  thinking?: ThinkingParams;
  /** Shared file locks; the clone holds them under `<agent>#clone`. */
  locks?: FileLockRegistry;
  /** Shared undo registry; the clone's edits are snapshotted under `<agent>#clone`. */
  undo?: FileUndoRegistry;
  /** Live plan-mode flag; when true the clone's toolset drops write/edit too. */
  planMode?: () => boolean;
  /**
   * Fetch a named subagent's session history, or undefined when it has none.
   * Must NOT create the session on miss (unlike SessionPool.get).
   */
  getHistory: (agent: string) => Message[] | undefined;
  /** Forward the clone's progress events (UI visibility, /cost coverage). */
  onEvent?: (ev: CoreEvent) => void;
}

export interface ConsultInput {
  /** Name of the subagent whose history to consult. */
  agent: string;
  /** The question to answer from that history. */
  question: string;
  /**
   * Digest the history to text/thinking only (drops tool calls). Off by
   * default: the full clone keeps the byte-identical prefix with the source
   * session, so a hot subagent's prompt cache is hit for the whole history.
   * Use digest only for cold subagents, where the smaller prompt wins.
   */
  digest?: boolean;
  /** Restrict the clone to a subset of the built-in tools by name. */
  tools?: string[];
  /** Cap on the clone's iterations; default {@link DEFAULT_CONSULT_MAX_ITERATIONS}. */
  maxIterations?: number;
}

function buildConsultPrompt(agent: string, question: string): string {
  return [
    `You are a read-only snapshot of subagent "${agent}". The conversation above is that subagent's working history — treat it as ground truth for what it knows, saw, and did.`,
    '',
    `Answer the following question based on it (use your tools only to verify claims, never to modify anything):`,
    '',
    question,
  ].join('\n');
}

/** Concatenate text blocks into one; keep non-text blocks (thinking) in order after it. */
function mergeContent(blocks: ContentBlock[]): ContentBlock[] {
  const out: ContentBlock[] = [];
  let text = '';
  for (const b of blocks) {
    if (b.type === 'text') text += b.text;
    else out.push(b);
  }
  if (text) out.unshift({ type: 'text', text });
  return out;
}

/**
 * Merge consecutive same-role messages by concatenating their content blocks.
 * Required after dropping tool blocks (digest mode) which can leave adjacent
 * user or assistant messages — providers require alternating roles.
 */
function mergeAdjacentRoles(msgs: Message[]): Message[] {
  const merged: Message[] = [];
  for (const m of msgs) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === m.role) {
      prev.content = mergeContent([...prev.content, ...m.content]);
    } else {
      merged.push(m);
    }
  }
  return merged;
}

/**
 * Prepare a cloned subagent history for a consult run:
 * - deep-copies, so the source session is never touched;
 * - trims an unclosed trailing tool_call and its orphaned tool_result, so the
 *   history is a valid, closed prefix (providers reject an assistant tool_call
 *   with no matching result);
 * - optionally digests to text/thinking only (dropping tool blocks and merging
 *   consecutive same-role messages so roles keep alternating);
 * - appends the question as a user turn, merging into the last user message
 *   when the history ends with one (Anthropic rejects consecutive users).
 *
 * The result is byte-identical to the source history up to the question, so a
 * hot subagent's prompt cache covers the whole prefix.
 */
export function prepareConsultHistory(messages: Message[], question: string, opts: { digest?: boolean } = {}): Message[] {
  let msgs: Message[] = structuredClone(messages);
  // Trim an unclosed tool-call tail: assistant(tool_call) with no result, plus
  // any orphaned user(tool_result) following it. Loop because a trim can
  // expose another open call.
  while (msgs.length > 0) {
    const last = msgs[msgs.length - 1];
    const lastBlock = last.content[last.content.length - 1];
    const isOpenCall = last.role === 'assistant' && lastBlock?.type === 'tool_call';
    // Only treat as orphaned if the user message is purely tool_results
    // (no text content). A user message with text + tool_result is legitimate.
    const isOrphanResult = last.role === 'user'
      && last.content.every((b) => b.type === 'tool_result');
    if (!isOpenCall && !isOrphanResult) break;
    if (isOpenCall) {
      // Only remove trailing tool_call blocks; keep text/thinking before them
      while (last.content.length > 0 && last.content[last.content.length - 1].type === 'tool_call') {
        last.content.pop();
      }
      // If message is now empty, remove it entirely; otherwise keep the text
      if (last.content.length === 0) msgs.pop();
      else break; // text remains — valid closed prefix
    } else {
      msgs.pop(); // orphaned pure tool_result message
    }
  }
  if (opts.digest) {
    msgs = msgs
      .map((m) => ({
        role: m.role,
        content: m.content.filter((b): b is Extract<ContentBlock, { type: 'text' | 'thinking' }> =>
          b.type === 'text' || b.type === 'thinking'),
      }))
      .filter((m) => m.content.length > 0);
    // Dropping tool blocks can leave consecutive same-role messages; merge them
    // so the history stays valid for alternating-role providers.
    msgs = mergeAdjacentRoles(msgs);
  }
  // Append the question as a user turn, merging into a trailing user message
  // to preserve alternating roles.
  const questionBlock: Message['content'][number] = { type: 'text', text: question };
  const last = msgs[msgs.length - 1];
  if (last && last.role === 'user') {
    last.content = [...last.content, questionBlock];
  } else {
    msgs.push({ role: 'user', content: [questionBlock] });
  }
  return msgs;
}

/**
 * The `consult` tool: answer a question from a named subagent's session
 * history via a read-only clone. The clone is a fresh, disposable Session —
 * it never enters the session pool, never touches the source session, and
 * cannot delegate (builtins only), so there is no consult recursion.
 */
export function createConsultTool(opts: ConsultToolOptions): Tool {
  return {
    name: CONSULT_TOOL_NAME,
    description:
      'Ask a named subagent a question by consulting a read-only clone of its session history: the clone is built from that subagent\'s conversation (what it saw, did, and concluded) plus your question, answers once, and is destroyed — the subagent itself is not run and its history is not modified. Use it to ask a subagent about its past work without waking it. Cannot be used by subagents.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Name of the subagent whose session history to consult.' },
        question: { type: 'string', description: 'The question to answer from that history.' },
        digest: { type: 'boolean', description: 'Optional: strip tool calls from the history (cheaper for cold subagents, loses detail).' },
        tools: { type: 'array', items: { type: 'string' }, description: 'Optional restriction of the clone\'s built-in tools (bash, read, write, edit, ls, grep, glob).' },
        maxIterations: { type: 'number', description: `Optional cap on the clone's iterations (default ${DEFAULT_CONSULT_MAX_ITERATIONS}).` },
      },
      required: ['agent', 'question'],
    },
    async execute(input: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const args = input as ConsultInput;
      if (!args.agent || !args.question) {
        return { content: 'consult requires "agent" and "question"', isError: true };
      }
      const history = opts.getHistory(args.agent);
      if (!history || history.length === 0) {
        return { content: `Subagent "${args.agent}" has no session history to consult`, isError: true };
      }
      const holder = `${args.agent}#clone`;
      const messages = prepareConsultHistory(history, buildConsultPrompt(args.agent, args.question), { digest: args.digest });
      const session = new Session();
      session.start();
      session.replaceMessages(messages);
      const allowed = args.tools?.length
        ? opts.availableTools.filter((t) => args.tools!.includes(t.name))
        : opts.availableTools;
      // Plan mode is inherited by consult clones too: read-only stays read-only.
      const planTools = opts.planMode?.() ? allowed.filter((t) => !PLAN_BLOCKED_TOOLS.has(t.name)) : allowed;
      // Forward the clone's progress onto the main bus (UI + /cost), tagged
      // `<agent>#clone` so it is distinguishable from the source subagent.
      const unsub = opts.onEvent
        ? session.bus.subscribe((ev) => opts.onEvent!({ ...ev, agent: holder }))
        : undefined;
      try {
        const answer = await runAgent({
          client: opts.client,
          session,
          // The history (including the question) is pre-built above; an empty
          // prompt makes runAgent skip its own user-message injection.
          prompt: '',
          tools: planTools,
          cwd: opts.cwd,
          askPermission: opts.askPermission(),
          maxIterations: args.maxIterations ?? DEFAULT_CONSULT_MAX_ITERATIONS,
          maxContextTokens: opts.maxContextTokens,
          ...(opts.model !== undefined ? { model: opts.model } : {}),
          ...(opts.thinking ? { thinking: opts.thinking } : {}),
          ...(opts.locks ? { locks: opts.locks } : {}),
          ...(opts.undo ? { undo: opts.undo } : {}),
          agent: holder,
        });
        return { content: answer || '(consult returned no answer)' };
      } catch (e) {
        return { content: `Consult failed: ${(e as Error).message}`, isError: true };
      } finally {
        unsub?.();
        session.dispose();
      }
    },
  };
}
