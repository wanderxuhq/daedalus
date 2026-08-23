import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countTokens } from '../../src/agent/tokenizer.ts';

test('tokenizer: counts empty and short strings exactly (Claude BPE)', () => {
  assert.equal(countTokens(''), 0);
  assert.equal(countTokens('hello world'), 2);
});

test('tokenizer: handles CJK and emoji (multi-byte text does not trip it)', () => {
  assert.ok(countTokens('中文测试') > 0);
  assert.ok(countTokens('😀emoji🎉') > 0);
  // emoji text is never counted as its UTF-16 length (4+ chars per emoji).
  assert.ok(countTokens('😀emoji🎉') <= 8);
});

test('tokenizer: longer text never yields fewer tokens than its prefix', () => {
  assert.ok(countTokens('a'.repeat(500)) >= countTokens('a'.repeat(100)));
});

test('tokenizer: stays fast enough for context management (100 messages ≈ one encode each)', () => {
  const t0 = Date.now();
  let total = 0;
  for (let i = 0; i < 100; i++) {
    total += countTokens(`message number ${i}: the quick brown fox jumps over the lazy dog and then some padding text`);
  }
  const ms = Date.now() - t0;
  assert.ok(total > 0);
  // ~2ms per 100 short messages was measured; 2s is a generous CI-safe ceiling
  // that still catches the "re-init tokenizer per call" regression (~3.5s).
  assert.ok(ms < 2000, `100 countTokens calls took ${ms}ms — tokenizer re-initializing per call?`);
});
