import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderText } from '../../src/cli/render.ts';

test('renderText wraps in ANSI codes', () => {
  assert.equal(renderText('hi', 'bold'), '\x1b[1mhi\x1b[0m');
});
