import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitignoreMatcher, isIgnored, type IgnoreLayer } from '../../src/tools/gitignore.ts';

function matcher(content: string): GitignoreMatcher {
  const m = new GitignoreMatcher();
  m.addContent(content);
  return m;
}
function layer(base: string, m: GitignoreMatcher): IgnoreLayer {
  return { base, matcher: m };
}

test('comments, blanks and escaped hashes', () => {
  const m = matcher('# comment\n\nfoo\n\\#literal');
  assert.equal(m.test('foo', false), true);
  assert.equal(m.test('sub/foo', false), true); // unanchored → any depth
  assert.equal(m.test('#literal', false), true);
  assert.equal(m.test('bar', false), undefined);
});

test('negation wins when it comes after the ignore pattern', () => {
  const m = matcher('*.log\n!important.log');
  assert.equal(m.test('a.log', false), true);
  assert.equal(m.test('important.log', false), false); // re-included
  assert.equal(m.test('sub/important.log', false), false);
});

test('trailing slash is directory-only', () => {
  const m = matcher('build/');
  assert.equal(m.test('build', true), true);
  assert.equal(m.test('build', false), undefined); // a FILE named build is not ignored
  assert.equal(m.test('x/build/y', true), undefined); // dir-only patterns don't match descendants via this API
});

test('leading slash anchors to the base directory', () => {
  const m = matcher('/top.txt');
  assert.equal(m.test('top.txt', false), true);
  assert.equal(m.test('sub/top.txt', false), undefined);
});

test('a slash anywhere anchors; no slash matches basenames at any depth', () => {
  const anchored = matcher('sub/only.txt');
  assert.equal(anchored.test('sub/only.txt', false), true);
  assert.equal(anchored.test('deep/sub/only.txt', false), undefined);
  const basename = matcher('only.txt');
  assert.equal(basename.test('deep/deep/only.txt', false), true);
  assert.equal(basename.test('only.txt', false), true);
});

test('glob stars and globstars', () => {
  const m = matcher('*.log\n**/cache');
  assert.equal(m.test('a.log', false), true);
  assert.equal(m.test('logs/a.log', false), true); // * crosses no slash
  assert.equal(m.test('logs/a.txt', false), undefined);
  assert.equal(m.test('cache', true), true);
  assert.equal(m.test('a/b/cache', true), true);
});

test('isIgnored checks deepest layer first (deeper files override shallower)', () => {
  const root = matcher('secret.txt');
  const nested = matcher('!secret.txt');
  const stack = [layer('', root), layer('sub', nested)];
  assert.equal(isIgnored(stack, 'sub/secret.txt', false), false); // nested ! wins
  assert.equal(isIgnored(stack, 'other/secret.txt', false), true); // only root matches
});

test('isIgnored skips layers whose base does not prefix the path', () => {
  const stack = [layer('a', matcher('x')), layer('a/b', matcher('y'))];
  assert.equal(isIgnored(stack, 'a/b/y', false), true);
  assert.equal(isIgnored(stack, 'a/x', false), true);
  assert.equal(isIgnored(stack, 'c/x', false), false);
});
