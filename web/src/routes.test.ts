import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHash } from './routes.ts';

test('parseHash routes main / agent / sessions', () => {
  assert.deepEqual(parseHash(''), { route: 'main' });
  assert.deepEqual(parseHash('#/'), { route: 'main' });
  assert.deepEqual(parseHash('#/sessions'), { route: 'sessions' });
  assert.deepEqual(parseHash('#/agent/researcher'), { route: 'agent', name: 'researcher' });
  assert.deepEqual(parseHash('#/agent/a%20b'), { route: 'agent', name: 'a b' });
  assert.deepEqual(parseHash('#/unknown'), { route: 'main' });
});
