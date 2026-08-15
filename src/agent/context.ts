import type { Message } from '../ai/types.ts';

/** Minimum number of conversation turns that trimming always keeps. */
export const MIN_KEEP_TURNS = 2;

/**
 * Zero-dependency token estimate: 4 per message + 2 per content block + 1 token
 * per 4 chars of the block's text. Deliberately approximate and slightly
 * conservative — the goal is to avoid blowing the window, not exactness.
 */
export function estimateTokens(messages: Message[]): number {
  let n = 0;
  for (const m of messages) {
    n += 4;
    for (const b of m.content) {
      const text = b.type === 'text' ? b.text
        : b.type === 'thinking' ? b.thinking
        : b.type === 'tool_result' ? b.content
        : b.type === 'tool_call' ? JSON.stringify(b.input) : '';
      n += Math.ceil(text.length / 4);
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

/**
 * Drop oldest whole turns until the history fits `maxTokens` (or `MIN_KEEP_TURNS`
 * turns remain), keeping the system prefix and never dropping a protected message
 * (pulling the cut back to keep its whole turn). Returns the input array unchanged
 * when nothing is trimmed, so callers can detect a trim via `!==`.
 */
export function trimHistory(messages: Message[], opts: TrimOptions): Message[] {
  const estimate = opts.estimate ?? estimateTokens;
  const isProtected = opts.isProtected ?? isSkillBody;

  // Leading system messages are never trimmed.
  let start = 0;
  while (start < messages.length && messages[start].role === 'system') start++;
  const prefix = messages.slice(0, start);
  const conversation = messages.slice(start);
  if (conversation.length === 0) return messages;

  // Turn-boundary indices into `conversation` (start of each user prompt).
  const bounds: number[] = [];
  for (let i = 0; i < conversation.length; i++) {
    if (isPrompt(conversation[i])) bounds.push(i);
  }
  if (bounds.length === 0) return messages;

  // How many leading turns to drop (grows until within budget / at the floor).
  let cut = 0;
  while (
    cut < bounds.length - MIN_KEEP_TURNS &&
    estimate([...prefix, ...conversation.slice(bounds[cut])]) > opts.maxTokens
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

  if (cut === 0) return messages;
  return [...prefix, ...conversation.slice(bounds[cut])];
}
