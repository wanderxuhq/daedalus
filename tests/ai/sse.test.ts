import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSseStream } from '../../src/ai/sse.ts';

async function collect(chunks: string[]): Promise<string[]> {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
      controller.close();
    },
  });
  const out: string[] = [];
  for await (const ev of parseSseStream(stream)) out.push(ev);
  return out;
}

test('parses a single event', async () => {
  const evs = await collect(['data: hello\n\n']);
  assert.deepEqual(evs, ['hello']);
});

test('parses multiple events including CRLF', async () => {
  const evs = await collect(['data: one\r\n\r\ndata: two\n\n']);
  assert.deepEqual(evs, ['one', 'two']);
});

test('handles chunked/broken lines', async () => {
  const evs = await collect(['data: ab', 'c\n\n', 'data: x\n\n']);
  assert.deepEqual(evs, ['abc', 'x']);
});

test('folds multi-line data fields with newline', async () => {
  const evs = await collect(['data: line1\ndata: line2\n\n']);
  assert.deepEqual(evs, ['line1\nline2']);
});

test('ignores comment lines and empty data', async () => {
  const evs = await collect([': comment\ndata:\n\ndata: real\n\n']);
  assert.deepEqual(evs, ['', 'real']);
});
