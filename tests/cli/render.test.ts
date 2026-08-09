import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderText, renderToolCall } from '../../src/cli/render.ts';

test('renderText wraps in ANSI codes', () => {
  assert.equal(renderText('hi', 'bold'), '\x1b[1mhi\x1b[0m');
});

test('renderToolCall formats name and input', () => {
  const out = renderToolCall({ name: 'bash', input: { command: 'ls' } });
  assert.match(out, /bash/);
  assert.match(out, /ls/);
});
