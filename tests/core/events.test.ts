import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../../src/core/events.ts';
import type { CoreEvent } from '../../src/core/events.ts';

test('subscribe receives emitted events', () => {
  const bus = new EventBus();
  const got: CoreEvent[] = [];
  const unsub = bus.subscribe((ev) => got.push(ev));
  bus.emit({ type: 'session_start' });
  bus.emit({ type: 'text_delta', text: 'hi' });
  assert.equal(got.length, 2);
  assert.equal(got[0].type, 'session_start');
  assert.equal(got[1].type, 'text_delta');
  unsub();
});

test('unsubscribe stops delivery and is idempotent', () => {
  const bus = new EventBus();
  let count = 0;
  const unsub = bus.subscribe(() => count++);
  bus.emit({ type: 'session_start' });
  unsub();
  unsub();
  bus.emit({ type: 'session_end' });
  assert.equal(count, 1);
});

test('emitAll emits in order', () => {
  const bus = new EventBus();
  const got: string[] = [];
  bus.subscribe((ev) => got.push(ev.type));
  bus.emitAll([{ type: 'session_start' }, { type: 'session_end' }]);
  assert.deepEqual(got, ['session_start', 'session_end']);
});
