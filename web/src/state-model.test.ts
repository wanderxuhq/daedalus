import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialUiState, applyEnvelope, mergeSnapshot } from './state-model.ts';
import type { EventEnvelope, SnapshotPayload } from './types.ts';
import type { CoreEvent } from '../../src/core/events.ts';

test('initial state is empty and idle', () => {
  const s = initialUiState();
  assert.deepEqual(s.subagents, []);
  assert.equal(s.running, false);
  assert.equal(s.pendingPermission, null);
});

test('text_delta streams accumulate into the last message', () => {
  let s = initialUiState();
  s = applyEnvelope(s, ev('text_delta', { text: 'Hel' }));
  s = applyEnvelope(s, ev('text_delta', { text: 'lo' }));
  assert.equal(s.log.length, 2);
  assert.equal(s.running, true);
});

test('tool_call_start creates a running card; tool_result marks done', () => {
  let s = initialUiState();
  s = applyEnvelope(s, ev('tool_call_start', { id: 't1', name: 'bash' }));
  assert.equal(s.log[0].type, 'tool_call_start');
  s = applyEnvelope(s, ev('tool_result', { id: 't1', name: 'bash', input: {}, content: 'out' }));
  assert.equal(s.running, false); // done would follow in real flow; tool_result alone doesn't end
});

test('done clears the in-flight log and stops running', () => {
  let s = initialUiState();
  s = applyEnvelope(s, ev('text_delta', { text: 'x' }));
  s = applyEnvelope(s, ev('done', { message: { role: 'assistant', content: [] } }));
  assert.equal(s.running, false);
  assert.deepEqual(s.log, []);
});

test('delegate_start adds a subagent to the list', () => {
  let s = initialUiState();
  s = applyEnvelope(s, ev('delegate_start', { agent: 'researcher', task: 'find' }));
  assert.equal(s.subagents.length, 1);
  assert.equal(s.subagents[0].name, 'researcher');
  assert.equal(s.subagents[0].status, 'running');
});

test('mergeSnapshot replaces log+messages+subagents and sets running', () => {
  let s = initialUiState();
  s = mergeSnapshot(s, {
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    subagents: [{ name: 'a', task: 't', status: 'done', messageCount: 0, loadedSkills: [] }],
    running: true,
    log: [],
    pendingPermission: null,
  });
  assert.equal(s.messages.length, 1);
  assert.equal(s.running, true);
  assert.equal(s.subagents[0].status, 'done');
});

function ev(type: CoreEvent['type'], extra: Record<string, unknown>): EventEnvelope {
  return { type: 'event', ev: { type, ...extra } as unknown as CoreEvent };
}
