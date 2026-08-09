import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '../../src/core/session.ts';

test('start emits session_start, dispose emits session_end', () => {
  const s = new Session();
  const got: string[] = [];
  s.bus.subscribe((ev) => got.push(ev.type));
  s.start();
  s.dispose();
  assert.deepEqual(got, ['session_start', 'session_end']);
});

test('messages accumulate across addMessage calls', () => {
  const s = new Session();
  s.addMessage({ role: 'user', content: [{ type: 'text', text: 'a' }] });
  s.addMessage({ role: 'assistant', content: [{ type: 'text', text: 'b' }] });
  const msgs = s.getMessages();
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, 'user');
  assert.equal(msgs[1].role, 'assistant');
});

test('skill load state is tracked, emits event, and is queryable', () => {
  const s = new Session();
  const got: string[] = [];
  s.bus.subscribe((ev) => { if (ev.type === 'skill_load') got.push(ev.name); });
  assert.equal(s.isSkillLoaded('review'), false);
  s.markSkillLoaded('review');
  assert.equal(s.isSkillLoaded('review'), true);
  assert.deepEqual(s.getLoadedSkills(), ['review']);
  assert.deepEqual(got, ['review']);
});

test('markSkillLoaded is idempotent (no duplicate events)', () => {
  const s = new Session();
  let count = 0;
  s.bus.subscribe((ev) => { if (ev.type === 'skill_load') count++; });
  s.markSkillLoaded('review');
  s.markSkillLoaded('review');
  assert.equal(count, 1);
});
