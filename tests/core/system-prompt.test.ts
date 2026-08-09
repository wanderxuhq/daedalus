import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt } from '../../src/core/system-prompt.ts';

test('buildSystemPrompt mentions Daedalus and tools guidance', () => {
  const p = buildSystemPrompt();
  assert.ok(p.includes('Daedalus'));
  assert.ok(p.length > 50);
});

test('buildSystemPrompt is deterministic (stable prefix)', () => {
  assert.equal(buildSystemPrompt(), buildSystemPrompt());
});
