import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFlags } from '../../src/cli/flags.ts';

test('--auto sets flags.auto', () => {
  assert.deepEqual(parseFlags(['--auto']), { auto: '1' });
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

test('--auto can combine with --resume', () => {
  const flags = parseFlags(['--resume', '--auto']);
  assert.equal(flags.resume, '1');
  assert.equal(flags.auto, '1');
});
