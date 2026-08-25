import { AiError } from './errors.ts';

export interface HttpClientConfig {
  baseURL: string;
  apiKey: string;
  timeoutMs?: number;
  maxRetries?: number;
}

const DEFAULT_TIMEOUT = 120_000;
const DEFAULT_MAX_RETRIES = 3;

export class HttpClient {
  private readonly baseURL: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(config: HttpClientConfig) {
    this.baseURL = config.baseURL.replace(/\/$/, '');
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT;
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  async stream(path: string, body: unknown, opts?: { signal?: AbortSignal }): Promise<ReadableStream<Uint8Array>> {
    const url = `${this.baseURL}${path}`;
    let attempt = 0;
    while (true) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      const signal = opts?.signal;
      const onAbort = () => controller.abort();
      signal?.addEventListener('abort', onAbort);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          const kind = res.status === 401 || res.status === 403 ? 'auth'
            : res.status === 429 ? 'rateLimit'
            : res.status >= 500 ? 'server'
            : 'badRequest';
          const err = new AiError(kind, `HTTP ${res.status}: ${errText.slice(0, 300)}`, { status: res.status });
          if (err.retryable && attempt < this.maxRetries) {
            attempt++;
            await sleep(500 * 2 ** attempt, signal);
            continue;
          }
          throw err;
        }
        return res.body!;
      } catch (e) {
        // Caller-initiated cancellation must not be retried.
        if (signal?.aborted) {
          throw cancellationError();
        }
        if (e instanceof AiError) throw e;
        const aborted = (e as Error).name === 'AbortError';
        const kind = aborted ? 'timeout' : 'network';
        const err = new AiError(kind, (e as Error).message);
        if (err.retryable && attempt < this.maxRetries) {
          attempt++;
          await sleep(500 * 2 ** attempt, signal);
          continue;
        }
        throw err;
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
      }
    }
  }
}

function cancellationError(): AiError {
  return new AiError('timeout', 'Request cancelled by caller', { retryable: false });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (timeout) clearTimeout(timeout);
      reject(cancellationError());
    };
    timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort);
    if (signal?.aborted) onAbort();
  });
}
