import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderText, formatToolInput, formatToolBody } from '../../src/cli/render.ts';

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
