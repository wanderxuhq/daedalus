import type { Message } from '../ai/types.ts';
import { countTokens } from './tokenizer.ts';

/** Minimum number of conversation turns that trimming/compaction always keeps. */
export const MIN_KEEP_TURNS = 2;

/**
 * Token estimate: 4 per message + 2 per content block + the block's text
 * counted by the exact Claude tokenizer (`countTokens`, which falls back to a
 * char/4 heuristic if the dependency is unavailable). The per-message and
 * per-block constants approximate the API framing overhead — deliberately
 * conservative, since the goal is to avoid blowing the window.
 */
export function estimateTokens(messages: Message[]): number {
  let n = 0;
  for (const m of messages) {
    n += 4;
    for (const b of m.content) {
      const text = b.type === 'text' ? b.text
        : b.type === 'thinking' ? b.thinking
        : b.type === 'tool_result' ? b.content
        : b.type === 'tool_call' ? JSON.stringify(b.input) ?? '' : '';
      n += countTokens(text);
      n += 2;
    }
  }
  return n;
}

export interface TrimOptions {
  /** History budget in estimated tokens. */
  maxTokens: number;
  /** Injectable estimator (tests use a message-count function). */
  estimate?: typeof estimateTokens;
  /** A message the trimmer must never drop. Default: skill-body messages. */
  isProtected?: (m: Message) => boolean;
}

/**
 * A user "prompt" message: role user whose content is not entirely tool_result
 * blocks (tool results are themselves user-role and must not start a turn).
 */
function isPrompt(m: Message): boolean {
  return m.role === 'user' && m.content.some((c) => c.type !== 'tool_result');
}

/** Skill bodies arrive as `[Skill: <name>]\n\n<body>` in text (engine path) or
 *  tool_result content (Skill-tool path). Either form must never be trimmed while
 *  `loadedSkills` still marks it loaded. */
function isSkillBody(m: Message): boolean {
  return m.content.some((b) =>
    (b.type === 'text' && b.text.startsWith('[Skill: ')) ||
    (b.type === 'tool_result' && b.content.startsWith('[Skill: ')),
  );
}

export interface TurnAnalysis {
  /** Leading system messages (never trimmed/compacted). */
  prefix: Message[];
  /** Everything after the system prefix. */
  conversation: Message[];
  /** Indices into `conversation` where each user prompt turn starts. */
  bounds: number[];
}

/** Split a history into its immutable system prefix and the turn-bounded conversation. */
export function analyzeTurns(messages: Message[]): TurnAnalysis {
  let start = 0;
  while (start < messages.length && messages[start].role === 'system') start++;
  const prefix = messages.slice(0, start);
  const conversation = messages.slice(start);
  const bounds: number[] = [];
  for (let i = 0; i < conversation.length; i++) {
    if (isPrompt(conversation[i])) bounds.push(i);
  }
  return { prefix, conversation, bounds };
}

/**
 * How many leading turns must go — dropped by trimHistory or summarized by
 * compactHistory — to fit the budget (big-step to `maxTokens * 0.75`, never below
 * `MIN_KEEP_TURNS` turns, never across a protected message). 0 = under budget.
 */
export function computeTrimCut(messages: Message[], opts: TrimOptions): number {
  const estimate = opts.estimate ?? estimateTokens;
  const isProtected = opts.isProtected ?? isSkillBody;
  const { prefix, conversation, bounds } = analyzeTurns(messages);
  if (bounds.length === 0) return 0;

  // Per-message token cost, computed ONCE (one encode per message), then a
  // suffix sum. The previous loop re-estimated the whole remaining history at
  // every cut step — fine under char/4, quadratic under a real tokenizer.
  const costs = conversation.map((m) => estimate([m]));
  const suffix = new Array<number>(conversation.length + 1);
  suffix[conversation.length] = 0;
  for (let i = conversation.length - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + costs[i];
  const prefixCost = prefix.reduce((n, m) => n + estimate([m]), 0);

  let cut = 0;
  while (
    cut < bounds.length - MIN_KEEP_TURNS &&
    prefixCost + suffix[bounds[cut]] > opts.maxTokens * 0.75
  ) {
    cut++;
  }

  // Pull the cut back before the earliest protected turn inside the dropped region.
  let protectIdx = -1;
  for (let k = 0; k < cut; k++) {
    const turnEnd = bounds[k + 1] ?? conversation.length;
    for (let j = bounds[k]; j < turnEnd; j++) {
      if (isProtected(conversation[j])) { protectIdx = k; break; }
    }
    if (protectIdx >= 0) break;
  }
  if (protectIdx >= 0) cut = protectIdx;

  return cut;
}

/**
 * Drop oldest whole turns until the history fits `maxTokens * 0.75` (the
 * "big-step to 75% of budget" target; or `MIN_KEEP_TURNS` turns remain), keeping the
 * system prefix and never dropping a protected message
 * (pulling the cut back to keep its whole turn). Returns the input array unchanged
 * when nothing is trimmed, so callers can detect a trim via `!==`.
 */
export function trimHistory(messages: Message[], opts: TrimOptions): Message[] {
  const { prefix, conversation, bounds } = analyzeTurns(messages);
  if (bounds.length === 0) return messages;
  const cut = computeTrimCut(messages, opts);
  if (cut === 0) return messages;
  return [...prefix, ...conversation.slice(bounds[cut])];
}
