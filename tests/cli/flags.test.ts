import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFlags } from '../../src/cli/flags.ts';

test('--yes sets flags.yes', () => {
  assert.deepEqual(parseFlags(['--yes']), { yes: '1' });
});

test('--provider, --model, --base-url pass through', () => {
  const flags = parseFlags(['--provider', 'openai', '--model', 'gpt-4.1', '--base-url', 'http://x']);
  assert.equal(flags.provider, 'openai');
  assert.equal(flags.model, 'gpt-4.1');
  assert.equal(flags.baseUrl, 'http://x');
});

test('--resume with a value and without a value', () => {
  assert.deepEqual(parseFlags(['--resume', '2026-08-09T23-15-07']), { resume: '2026-08-09T23-15-07' });
  assert.deepEqual(parseFlags(['--resume']), { resume: '1' });
});

test('--yes can combine with --resume', () => {
  const flags = parseFlags(['--resume', '--yes']);
  assert.equal(flags.resume, '1');
  assert.equal(flags.yes, '1');
});
