import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unifiedDiff } from '../../src/tools/diff.ts';

test('identical texts produce no diff', () => {
  assert.equal(unifiedDiff('same', 'same'), '');
  assert.equal(unifiedDiff('', ''), '');
});

test('single-line replacement marks -/+ lines with a hunk header', () => {
  const d = unifiedDiff('foo bar baz', 'foo QUX baz');
  assert.ok(d.startsWith('@@ -1,1 +1,1 @@'));
  assert.ok(d.includes('-foo bar baz'));
  assert.ok(d.includes('+foo QUX baz'));
});

test('multi-line edit keeps 2 context lines around the change', () => {
  const oldText = ['a1', 'a2', 'a3', 'OLD', 'a4', 'a5'].join('\n');
  const newText = ['a1', 'a2', 'a3', 'NEW', 'a4', 'a5'].join('\n');
  const d = unifiedDiff(oldText, newText);
  assert.ok(d.includes('-OLD'));
  assert.ok(d.includes('+NEW'));
  assert.ok(d.includes(' a3')); // context before the change
  assert.ok(d.includes(' a4')); // context after the change
});

test('creating a file diffs from /dev/null (all additions)', () => {
  const d = unifiedDiff('', 'line1\nline2');
  assert.ok(d.includes('@@ -0,0 +1,2 @@'));
  assert.ok(d.includes('+line1'));
  assert.ok(d.includes('+line2'));
  assert.ok(!d.includes('-line'));
});

test('deleting content produces - lines with no + counterpart', () => {
  const d = unifiedDiff('keep\ndrop\nkeep2', 'keep\nkeep2');
  assert.ok(d.includes('-drop'));
  assert.ok(!d.includes('+drop'));
});

test('CRLF files produce diffs without stray \r characters (terminal-safe cards)', () => {
  const d = unifiedDiff('a\r\nold\r\nz\r\n', 'a\r\nnew\r\nz\r\n');
  assert.ok(d.includes('-old'));
  assert.ok(d.includes('+new'));
  assert.ok(!d.includes('\r'), `no carriage returns should survive into the diff card: ${JSON.stringify(d)}`);
  // The surrounding context lines keep their content.
  assert.ok(d.includes(' a'));
  assert.ok(d.includes(' z'));
});
