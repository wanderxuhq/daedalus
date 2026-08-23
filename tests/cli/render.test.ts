import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ANSI, renderText, formatToolInput, formatToolBody, formatDiff, formatToolCard, renderEvent, streamAnswerOnly } from '../../src/cli/render.ts';

/** Capture everything written to stdout during `fn`, restoring the original. */
function captureStdout(fn: () => void): string {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string | Uint8Array) => { chunks.push(String(s)); return true; }) as typeof process.stdout.write;
  try {
    fn();
  } finally {
    process.stdout.write = orig;
  }
  return chunks.join('');
}

test('renderText wraps in ANSI codes', () => {
  assert.equal(renderText('hi', 'bold'), '\x1b[1mhi\x1b[0m');
});

test('formatToolInput: bash shows the shell command, not JSON', () => {
  assert.equal(formatToolInput('bash', { command: 'ls -la' }), '$ ls -la');
});

test('formatToolInput: read shows path and 1-based line range for partial reads', () => {
  assert.equal(formatToolInput('read', { path: 'src/a.ts' }), 'src/a.ts');
  assert.equal(formatToolInput('read', { path: 'src/a.ts', offset: 10 }), 'src/a.ts:11…');
  assert.equal(formatToolInput('read', { path: 'src/a.ts', offset: 10, limit: 5 }), 'src/a.ts:11-15');
  assert.equal(formatToolInput('read', { path: 'src/a.ts', limit: 5 }), 'src/a.ts:1-5');
});

test('formatToolInput: write/edit/ls/grep/glob/Skill summarize their target', () => {
  assert.equal(formatToolInput('write', { path: 'out.txt', content: 'x'.repeat(1000) }), 'out.txt');
  assert.equal(formatToolInput('edit', { path: 'src/a.ts' }), 'src/a.ts');
  assert.equal(formatToolInput('ls', {}), '.');
  assert.equal(formatToolInput('ls', { path: 'src' }), 'src');
  assert.equal(formatToolInput('grep', { pattern: 'TODO' }), 'TODO in .');
  assert.equal(formatToolInput('grep', { pattern: 'TODO', path: 'src' }), 'TODO in src');
  assert.equal(formatToolInput('glob', { pattern: '*.ts', path: 'src' }), '*.ts in src');
  assert.equal(formatToolInput('Skill', { name: 'review' }), 'review');
});

test('formatToolInput: unknown tool falls back to raw JSON (clipped)', () => {
  assert.equal(formatToolInput('weird', { a: 1 }), '{"a":1}');
  const long = { data: 'x'.repeat(500) };
  assert.ok(formatToolInput('weird', long).length <= 120);
});

test('formatToolBody: prefixes each line with a │ bar', () => {
  assert.equal(formatToolBody('a\nb', false), '\x1b[2m│\x1b[0m a\n\x1b[2m│\x1b[0m b');
});

test('formatToolBody: errors are red, trailing newline is stripped', () => {
  assert.equal(formatToolBody('boom\n', true), '\x1b[31m│\x1b[0m \x1b[31mboom\x1b[0m');
});

test('formatToolBody: long output is clipped with a dim note', () => {
  const many = Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\n');
  const out = formatToolBody(many, false);
  assert.ok(out.includes('line 0'));
  assert.ok(out.includes('line 49'));
  assert.ok(out.includes('… 30 more lines omitted'));
  assert.ok(!out.includes('line 50'));
});

test('formatDiff: additions green, removals red, headers cyan, context dim', () => {
  const d = '@@ -1,2 +1,2 @@\n a\n-old\n+new';
  const out = formatDiff(d);
  assert.ok(out.includes('\x1b[32m+new\x1b[0m'));       // green addition
  assert.ok(out.includes('\x1b[31m-old\x1b[0m'));       // red removal
  assert.ok(out.includes('\x1b[36m@@ -1,2 +1,2 @@\x1b[0m')); // cyan header
  assert.ok(out.includes('\x1b[2m a\x1b[0m'));          // dim context
});

test('formatDiff: oversized diffs are clipped with a dim note', () => {
  const big = `@@ -1,80 +1,80 @@\n${Array.from({ length: 80 }, (_, i) => `+line ${i}`).join('\n')}`;
  const out = formatDiff(big);
  assert.ok(out.includes('+line 0'));
  assert.ok(out.includes('+line 58'));
  assert.ok(out.includes('… 21 more diff lines omitted'));
  assert.ok(!out.includes('+line 59'));
});

test('formatToolCard: header + diff body, shared by the stream renderer and the TUI', () => {
  const card = formatToolCard('edit', { path: 'src/a.ts' }, 'Edited src/a.ts', { diff: '@@ -1,1 +1,1 @@\n-old\n+new' });
  const lines = card.split('\n');
  assert.equal(lines.length, 4); // header + hunk + -old + +new
  assert.ok(lines[0].includes('⏺ edit'));      // colored header word
  assert.ok(lines[0].includes('src/a.ts'));     // summary drawn after the reset
  assert.ok(lines[1].includes('@@ -1,1 +1,1 @@'));
  assert.ok(lines[2].includes('-old'));
  assert.ok(lines[3].includes('+new'));
});

/* --------------------------- streaming renderers --------------------------- */

test('renderEvent: a thinking segment is styled once, not per chunk, and the answer starts on a new line', () => {
  const out = captureStdout(() => {
    renderEvent({ type: 'thinking_delta', thinking: 'The ' });
    renderEvent({ type: 'thinking_delta', thinking: 'user said' });
    renderEvent({ type: 'text_delta', text: 'ok' });
    renderEvent({ type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } });
  });
  // One dim-italic run for the whole thinking segment (NOT per word), then a
  // newline, then the answer.
  assert.ok(out.includes(`${ANSI.dim}${ANSI.italic}The user said${ANSI.reset}\nok`), out);
  // No leftover style codes inside the run (the old bug wrapped every chunk).
  assert.equal(out.split(ANSI.dim).length, 2); // exactly one open + close pair
});

test('renderEvent: thinking is flushed before a tool card so they do not interleave', () => {
  const out = captureStdout(() => {
    renderEvent({ type: 'thinking_delta', thinking: 'planning…' });
    renderEvent({ type: 'tool_call_start', id: 't1', name: 'read' });
    renderEvent({ type: 'tool_result', id: 't1', name: 'read', input: { path: 'src/a.ts' }, content: 'x' });
    renderEvent({ type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: '' }] } });
  });
  assert.ok(out.includes(`${ANSI.dim}${ANSI.italic}planning…${ANSI.reset}\n`), out);
});

test('streamAnswerOnly: streams only the answer text and reports whether it streamed', () => {
  const r = streamAnswerOnly();
  const out = captureStdout(() => {
    r.handler({ type: 'thinking_delta', thinking: 'hidden' });
    r.handler({ type: 'tool_call_start', id: 't1', name: 'bash' });
    r.handler({ type: 'text_delta', text: 'answer' });
  });
  assert.equal(out, 'answer'); // no thinking, no cards
  assert.equal(r.hasOutput(), true);
});

test('streamAnswerOnly: no output when only non-text events arrive', () => {
  const r = streamAnswerOnly();
  captureStdout(() => {
    r.handler({ type: 'thinking_delta', thinking: 'hidden' });
    r.handler({ type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: '' }] } });
  });
  assert.equal(r.hasOutput(), false);
});
