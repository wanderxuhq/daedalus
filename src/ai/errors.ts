export type AiErrorKind =
  | 'auth' | 'rateLimit' | 'server' | 'badRequest' | 'timeout' | 'network' | 'parse';

const RETRYABLE = new Set<AiErrorKind>(['rateLimit', 'server', 'timeout', 'network']);

export class AiError extends Error {
  readonly kind: AiErrorKind;
  readonly status?: number;
  readonly retryable: boolean;

  constructor(kind: AiErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'AiError';
    this.kind = kind;
    this.status = status;
    this.retryable = RETRYABLE.has(kind);
  }
}
