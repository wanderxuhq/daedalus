export async function* parseSseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines: string[] = [];

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
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
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
