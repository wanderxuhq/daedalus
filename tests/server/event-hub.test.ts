import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventHub } from '../../src/server/event-hub.ts';
import type { CoreEvent } from '../../src/core/events.ts';

function ev(partial: Partial<CoreEvent> & { type: CoreEvent['type'] }): CoreEvent {
  return partial as CoreEvent;
}

test('tracks task from delegate_start and status transitions', () => {
  const hub = new EventHub();
  hub.handle(ev({ type: 'delegate_start', agent: 'researcher', task: 'find the bug' }));
  assert.deepEqual(hub.list(), [
    { name: 'researcher', task: 'find the bug', status: 'running', messageCount: 0, loadedSkills: [] },
  ]);
  hub.handle(ev({ type: 'done', agent: 'researcher', message: { role: 'assistant', content: [] } }));
  assert.equal(hub.list()[0].status, 'done');
});

test('untagged events are ignored', () => {
  const hub = new EventHub();
  hub.handle(ev({ type: 'delegate_start', task: 'x' }));
  assert.equal(hub.list().length, 0);
});

test('agents appear in first-seen order; repeated delegates keep one row', () => {
  const hub = new EventHub();
  hub.handle(ev({ type: 'delegate_start', agent: 'a', task: '1' }));
  hub.handle(ev({ type: 'delegate_start', agent: 'b', task: '2' }));
  hub.handle(ev({ type: 'delegate_start', agent: 'a', task: '3' }));
  assert.deepEqual(hub.list().map((a) => a.name), ['a', 'b']);
  assert.equal(hub.list()[0].task, '3');
});

test('reset clears all agents', () => {
  const hub = new EventHub();
  hub.handle(ev({ type: 'delegate_start', agent: 'a', task: '1' }));
  hub.reset();
  assert.deepEqual(hub.list(), []);
});
