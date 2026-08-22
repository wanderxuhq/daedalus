import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMessage } from './ws.ts';

test('parseMessage decodes envelopes and ignores junk', () => {
  assert.equal(parseMessage('{"type":"event","ev":{"type":"text_delta","text":"x"}}').ev.text, 'x');
  assert.equal(parseMessage('not json'), null);
});
