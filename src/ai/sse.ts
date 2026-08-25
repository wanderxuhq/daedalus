import { AiError } from './errors.ts';

const DEFAULT_STREAM_TIMEOUT_MS = 120_000;

export async function* parseSseStream(body: ReadableStream<Uint8Array>, opts?: { timeoutMs?: number }): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines: string[] = [];
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS;

  const flushEvent = (): string | null => {
    if (dataLines.length === 0) return null;
    const payload = dataLines.join('\n');
    dataLines = [];
    return payload;
  };

  const handleLine = (line: string): string | null => {
    if (line === '') return flushEvent();
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    // ':' comment lines and 'event:'/'id:' lines are ignored
    return null;
  };

  try {
    while (true) {
      // Wrap reader.read() with a per-chunk timeout to detect provider stalls.
      // Without this, a stalled LLM stream causes reader.read() to block
      // forever, hanging the entire engine with no recovery path.
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new AiError('timeout', `SSE stream stalled: no data received for ${timeoutMs}ms`)), timeoutMs);
        // Unref the timer so it doesn't keep the process alive on its own
        if (typeof timeoutHandle === 'object' && 'unref' in timeoutHandle) timeoutHandle.unref();
      });
      let readResult: ReadableStreamReadResult<Uint8Array>;
      try {
        readResult = await Promise.race([reader.read(), timeout]);
        if (timeoutHandle) clearTimeout(timeoutHandle);
      } catch (e) {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        // Cancel the reader so the pending read() settles and the lock is released
        reader.cancel(e instanceof Error ? e : undefined).catch(() => {});
        throw e;
      }
      if (readResult.done) break;
      buffer += decoder.decode(readResult.value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        const payload = handleLine(line);
        if (payload !== null) yield payload;
      }
    }
    // flush trailing line and any unterminated event
    if (buffer.length > 0) {
      const payload = handleLine(buffer.replace(/\r$/, ''));
      if (payload !== null) yield payload;
    }
    const trailing = flushEvent();
    if (trailing !== null) yield trailing;
  } finally {
    reader.releaseLock();
  }
}
