import { getTokenizer } from '@anthropic-ai/tokenizer';

/**
 * Minimum shape of the tokenizer we need. Kept structural instead of importing
 * tiktoken's types so this module never couples to the dependency's type
 * surface (the package is CJS; Node ESM interop resolves the named export).
 */
interface Encoder {
  encode(text: string, allowedSpecial?: string | 'all' | Set<string>): { length: number };
}

// getTokenizer() rebuilds the tokenizer — vocabulary load included — on EVERY
// call (~35ms). Cache the instance; encode() afterwards is fast (~26ms per
// 100k chars, ~2ms for 100 short messages).
let encoder: Encoder | null = null;
let initTried = false;

/**
 * Exact token count via Anthropic's Claude tokenizer (BPE ranks from
 * `@anthropic-ai/tokenizer`). Falls back to the old `ceil(len/4)` heuristic —
 * silently, at first use — when the dependency is missing (0-dependency
 * embedders) or the tokenizer fails to initialize, so the context manager
 * never crashes over a counting detail.
 */
export function countTokens(text: string): number {
  if (text.length === 0) return 0;
  if (!encoder) {
    if (!initTried) {
      initTried = true;
      try {
        encoder = getTokenizer() as unknown as Encoder;
      } catch {
        encoder = null;
      }
    }
    if (!encoder) return Math.ceil(text.length / 4);
  }
  try {
    return encoder.encode(text, 'all').length;
  } catch {
    return Math.ceil(text.length / 4);
  }
}
