import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialUiState, applyEnvelope } from '../../web/src/state-model.ts';
import type { UiState } from '../../web/src/state-model.ts';
import type { CoreEvent } from '../../src/core/events.ts';
import type { EventEnvelope } from '../../web/src/types.ts';
import type { Message } from '../../src/ai/types.ts';

function msg(role: 'assistant', text: string): Message {
  return { role, content: [{ type: 'text', text }] };
}

function env(ev: CoreEvent): EventEnvelope {
  return { type: 'event', ev };
}

// ─── turn_done / done duplicate-message regression ─────────────────────────

test('turn_done + done with the SAME message does NOT duplicate it in messages', () => {
  // Regression test: turn_done followed by done with the same message should
  // only appear once in the messages array (dedup by reference equality).
  const m = msg('assistant', 'Hello from the assistant');
  let state: UiState = initialUiState();

  state = applyEnvelope(state, env({ type: 'turn_done', message: m }));
  state = applyEnvelope(state, env({ type: 'done', message: m }));

  const assistantMessages = state.messages.filter(
    (x: any) => x.role === 'assistant',
  );
  assert.equal(
    assistantMessages.length,
    1,
    `expected exactly 1 assistant message after turn_done+done, got ${assistantMessages.length}`,
  );
  assert.deepEqual(assistantMessages[0], m);
});

test('turn_done + done with DIFFERENT messages both appear', () => {
  const m1 = msg('assistant', 'First reply');
  const m2 = msg('assistant', 'Second reply');
  let state: UiState = initialUiState();

  state = applyEnvelope(state, env({ type: 'turn_done', message: m1 }));
  state = applyEnvelope(state, env({ type: 'done', message: m2 }));

  const assistantMessages = state.messages.filter(
    (x: any) => x.role === 'assistant',
  );
  assert.equal(assistantMessages.length, 2, 'expected 2 distinct assistant messages');
  assert.deepEqual(assistantMessages[0], m1);
  assert.deepEqual(assistantMessages[1], m2);
});

test('done alone adds the assistant message', () => {
  const m = msg('assistant', 'Only done');
  let state: UiState = initialUiState();

  state = applyEnvelope(state, env({ type: 'done', message: m }));

  const assistantMessages = state.messages.filter(
    (x: any) => x.role === 'assistant',
  );
  assert.equal(assistantMessages.length, 1);
  assert.deepEqual(assistantMessages[0], m);
});

test('turn_done alone adds the assistant message', () => {
  const m = msg('assistant', 'Only turn_done');
  let state: UiState = initialUiState();

  state = applyEnvelope(state, env({ type: 'turn_done', message: m }));

  const assistantMessages = state.messages.filter(
    (x: any) => x.role === 'assistant',
  );
  assert.equal(assistantMessages.length, 1);
  assert.deepEqual(assistantMessages[0], m);
});

test('non-assistant message is ignored by turn_done and done', () => {
  const m: Message = { role: 'user', content: [{ type: 'text', text: 'hi' }] };
  let state: UiState = initialUiState();

  state = applyEnvelope(state, env({ type: 'turn_done', message: m }));
  state = applyEnvelope(state, env({ type: 'done', message: m }));

  assert.equal(state.messages.length, 0, 'non-assistant messages should not be appended');
});

test('streamingMessage is cleared after turn_done', () => {
  const m = msg('assistant', 'streamed');
  let state: UiState = initialUiState();

  // Simulate having an in-progress streaming message
  state = {
    ...state,
    streamingMessage: { role: 'assistant', content: [{ type: 'text', text: 'partial' }] },
  };
  state = applyEnvelope(state, env({ type: 'turn_done', message: m }));

  assert.equal(state.streamingMessage, null, 'streamingMessage should be cleared after turn_done');
});

test('streamingMessage is cleared after done', () => {
  const m = msg('assistant', 'done msg');
  let state: UiState = initialUiState();

  state = {
    ...state,
    streamingMessage: { role: 'assistant', content: [{ type: 'text', text: 'partial' }] },
  };
  state = applyEnvelope(state, env({ type: 'done', message: m }));

  assert.equal(state.streamingMessage, null, 'streamingMessage should be cleared after done');
});

test('state.running is false after done (terminal event)', () => {
  const m = msg('assistant', 'all done');
  let state: UiState = initialUiState();

  // Simulate running state
  state = applyEnvelope(state, env({ type: 'session_start' }));
  assert.equal(state.running, true);

  state = applyEnvelope(state, env({ type: 'done', message: m }));
  assert.equal(state.running, false, 'running should be false after done');
});

test('state.running is false after turn_done (non-terminal, log gets cleared when followed by done)', () => {
  const m = msg('assistant', 'turn finished');
  let state: UiState = initialUiState();

  state = applyEnvelope(state, env({ type: 'session_start' }));
  assert.equal(state.running, true);

  // turn_done is NOT in TERMINALS, so log is not cleared; running stays true
  state = applyEnvelope(state, env({ type: 'turn_done', message: m }));
  assert.equal(state.running, true, 'running should still be true after turn_done (non-terminal)');
});

test('multiple turn_done events accumulate messages', () => {
  const m1 = msg('assistant', 'turn 1');
  const m2 = msg('assistant', 'turn 2');
  const m3 = msg('assistant', 'turn 3');
  let state: UiState = initialUiState();

  state = applyEnvelope(state, env({ type: 'turn_done', message: m1 }));
  state = applyEnvelope(state, env({ type: 'turn_done', message: m2 }));
  state = applyEnvelope(state, env({ type: 'turn_done', message: m3 }));

  const assistantMessages = state.messages.filter(
    (x: any) => x.role === 'assistant',
  );
  assert.equal(assistantMessages.length, 3);
});

test('back-to-back done events with same message are deduplicated', () => {
  const m = msg('assistant', 'result');
  let state: UiState = initialUiState();

  // Two consecutive done events with the same message should be deduplicated
  // (reference equality check prevents duplicates).
  state = applyEnvelope(state, env({ type: 'done', message: m }));
  state = applyEnvelope(state, env({ type: 'done', message: m }));

  const assistantMessages = state.messages.filter(
    (x: any) => x.role === 'assistant',
  );
  assert.equal(
    assistantMessages.length,
    1,
    'two done events with the same message should produce only one entry (dedup)',
  );
});
