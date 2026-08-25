export type AiErrorKind =
  | 'auth' | 'rateLimit' | 'server' | 'badRequest' | 'timeout' | 'network' | 'parse' | 'protocol';

const RETRYABLE = new Set<AiErrorKind>(['rateLimit', 'server', 'timeout', 'network']);

export class AiError extends Error {
  readonly kind: AiErrorKind;
  readonly status?: number;
  readonly retryable: boolean;

  constructor(kind: AiErrorKind, message: string, opts?: { status?: number; retryable?: boolean }) {
    super(message);
    this.name = 'AiError';
    this.kind = kind;
    this.status = opts?.status;
    this.retryable = opts?.retryable ?? RETRYABLE.has(kind);
  }
}

/**
 * True when the error means "the caller aborted this request" (Ctrl+C interrupt).
 * Matches the pre-request abort path (AiError kind 'timeout') AND a mid-stream
 * abort: the providers rethrow the DOM's raw `AbortError` untouched when the
 * body reader is aborted mid-iteration, so the REPL would otherwise show it as
 * a red error instead of "(interrupted)".
 */
export function isCancellationError(e: unknown): boolean {
  if (e instanceof AiError && e.kind === 'timeout' && /cancel/i.test(e.message)) return true;
  return typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AbortError';
}
