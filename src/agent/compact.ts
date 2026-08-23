import type { AiClient, Message } from '../ai/types.ts';
import { analyzeTurns, computeTrimCut, type TrimOptions } from './context.ts';

/**
 * CC-style auto-compact: when history exceeds the context budget, hand the
 * OLDEST whole turns to the model and replace them with a single dense summary
 * instead of dropping them wholesale (trimHistory is the lossy fallback).
 *
 * The summary is merged into the first surviving user prompt as a leading text
 * block rather than inserted as its own message: both supported providers
 * require user/assistant roles to alternate, and a standalone summary message
 * would sit between two user turns.
 */

/** Instructions for the compactor model. Deliberately output-only. */
const COMPACT_SYSTEM = [
  'You are a conversation compactor for Daedalus, a terminal coding agent.',
  'You are given the OLDEST turns of an ongoing conversation. Produce ONE dense summary that preserves everything the agent still needs:',
  '- the user\'s goals and any pending or unfinished task state',
  '- decisions that were made and why',
  '- file paths, commands run, and their important outputs or errors',
  '- constraints, preferences, and instructions the user gave',
  '- open questions or the next step to take',
  'Write in the same language as the conversation. Be information-dense but concise. Output ONLY the summary text, no preamble or headings.',
].join('\n');

/** Ask the same model to compress a span of whole turns into one summary. */
export async function summarizeTurns(client: AiClient, turns: Message[]): Promise<string> {
  const system: Message = { role: 'system', content: [{ type: 'text', text: COMPACT_SYSTEM }] };
  let text = '';
  for await (const ev of client.streamChat({
    messages: [system, ...turns],
    tools: [],
    cache: { enabled: false },
    maxTokens: 1024,
  })) {
    if (ev.type === 'text_delta') text += ev.text;
    if (ev.type === 'error') throw ev.error;
  }
  return text.trim();
}

export interface CompactOptions extends TrimOptions {
  /** Compress a span of whole turns into a summary string. */
  summarize: (turns: Message[]) => Promise<string>;
}

export interface CompactResult {
  messages: Message[];
  /** Number of conversation messages replaced by the summary. */
  dropped: number;
}

/**
 * Replace the oldest over-budget turns with a model summary. Returns null when
 * nothing is over budget (nothing to compact) or the summarizer returned
 * nothing usable — callers then fall back to trimHistory.
 */
export async function compactHistory(messages: Message[], opts: CompactOptions): Promise<CompactResult | null> {
  const { prefix, conversation, bounds } = analyzeTurns(messages);
  if (bounds.length === 0) return null;
  const cut = computeTrimCut(messages, opts);
  if (cut === 0) return null;

  // Whole turns: prompt + assistant + any tool_result user messages.
  const droppedRegion = conversation.slice(0, bounds[cut]);
  const summary = await opts.summarize(droppedRegion);
  if (!summary) return null;

  const next = conversation[bounds[cut]]; // the first surviving turn — always a user prompt
  const merged: Message = {
    role: 'user',
    content: [
      { type: 'text', text: `[Earlier conversation summary]\n\n${summary}` },
      ...next.content,
    ],
  };
  return {
    messages: [...prefix, merged, ...conversation.slice(bounds[cut] + 1)],
    dropped: bounds[cut],
  };
}
