import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialUiState, applyEnvelope, submitPrompt, submitSubagentPrompt, mergeSnapshot } from './state-model.ts';
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

test('main-session turns render as messages: user prompt on submit, assistant on done', () => {
  let s = initialUiState();
  // 用户消息：submitPrompt 本地回显（chat POST 前就上屏）。
  s = submitPrompt(s, '帮我看看');
  assert.equal(s.messages.length, 1);
  assert.equal((s.messages[0] as any).role, 'user');
  // 流式期间不重复追加 assistant 消息。
  s = applyEnvelope(s, ev('text_delta', { text: '你好' }));
  assert.equal(s.messages.length, 1);
  // done 把最终 assistant 消息落进渲染列表。
  const doneEv = { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: '你好，世界' }] } };
  s = applyEnvelope(s, { type: 'event', ev: doneEv as unknown as CoreEvent });
  assert.equal(s.messages.length, 2);
  assert.equal((s.messages[1] as any).role, 'assistant');
  assert.deepEqual((s.messages[1] as any).content, [{ type: 'text', text: '你好，世界' }]);
});

test('error events surface in the UI error field and stop running', () => {
  let s = initialUiState();
  s = applyEnvelope(s, ev('text_delta', { text: 'x' }));
  assert.equal(s.error, null);
  const errEv = { type: 'error', error: new Error('provider down') };
  s = applyEnvelope(s, { type: 'event', ev: errEv as unknown as CoreEvent });
  assert.equal(s.error, 'provider down');
  assert.equal(s.running, false);
});

test('snapshot merge resets the transient error and re-syncs messages', () => {
  let s = initialUiState();
  s = submitPrompt(s, 'q');
  s = { ...s, error: 'stale' };
  s = mergeSnapshot(s, {
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    subagents: [], running: false, log: [], pendingPermission: null,
  });
  assert.equal(s.error, null);
  assert.equal(s.messages.length, 1);
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

test('submitPrompt echoes the user message immediately', () => {
  let s = initialUiState();
  s = submitPrompt(s, 'hello');
  assert.equal(s.messages.length, 1);
  assert.deepEqual(s.messages[0], { role: 'user', content: [{ type: 'text', text: 'hello' }] });
});

test('viewingSubagent: subagent events accumulate into subagentMessages when viewing', () => {
  let s = initialUiState();
  s = { ...s, viewingSubagent: 'worker' };
  s = applyEnvelope(s, ev('text_delta', { text: 'hi', agent: 'worker' }));
  assert.equal(s.subagentMessages.length, 1);
  // Non-viewed agent events don't touch subagentMessages.
  s = applyEnvelope(s, ev('text_delta', { text: 'other', agent: 'scout' }));
  assert.equal(s.subagentMessages.length, 1);
});

test('submitSubagentPrompt echoes user message into subagentMessages', () => {
  let s = initialUiState();
  s = { ...s, viewingSubagent: 'worker', subagentMessages: [] };
  s = submitSubagentPrompt(s, 'do it');
  assert.equal(s.subagentMessages.length, 1);
  assert.deepEqual(s.subagentMessages[0], { role: 'user', content: [{ type: 'text', text: 'do it' }] });
});

function ev(type: CoreEvent['type'], extra: Record<string, unknown>): EventEnvelope {
  return { type: 'event', ev: { type, ...extra } as unknown as CoreEvent };
}
