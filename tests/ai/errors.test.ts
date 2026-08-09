import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AiError } from '../../src/ai/errors.ts';

test('AiError carries kind and retryable flag', () => {
  const e = new AiError('rateLimit', 'slow down', 429);
  assert.equal(e.kind, 'rateLimit');
  assert.equal(e.retryable, true);
  assert.equal(e.message, 'slow down');
});
