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

test('getState deep-copies messages and skills', () => {
  const s = new Session();
  s.addMessage({ role: 'user', content: [{ type: 'text', text: 'a' }] });
  s.markSkillLoaded('review');
  const st = s.getState();
  assert.equal(st.messages.length, 1);
  assert.deepEqual(st.loadedSkills, ['review']);
  // Mutating the returned state must not leak into the session.
  st.messages[0].content = [];
  st.loadedSkills.push('x');
  assert.equal(s.getMessages()[0].content.length, 1);
  assert.deepEqual(s.getLoadedSkills(), ['review']);
});

test('replaceMessages swaps the whole history', () => {
  const s = new Session();
  s.addMessage({ role: 'system', content: [{ type: 'text', text: 'sys' }] });
  s.replaceMessages([{ role: 'user', content: [{ type: 'text', text: 'only' }] }]);
  assert.equal(s.getMessages().length, 1);
  assert.equal(s.getMessages()[0].role, 'user');
});

test('restoreLoadedSkills sets the set without emitting events', () => {
  const s = new Session();
  const got: string[] = [];
  s.bus.subscribe((ev) => { if (ev.type === 'skill_load') got.push(ev.name); });
  s.restoreLoadedSkills(['review', 'fix']);
  assert.deepEqual(s.getLoadedSkills(), ['review', 'fix']);
  assert.deepEqual(got, []);
  assert.equal(s.isSkillLoaded('review'), true);
});

test('getState deep-copies nested tool_call.input', () => {
  const s = new Session();
  s.addMessage({ role: 'assistant', content: [{ type: 'tool_call', id: 't', name: 'bash', input: { command: 'ls', flags: { a: true } } }] });
  const st = s.getState();
  const input = st.messages[0].content[0];
  if (input.type !== 'tool_call') throw new Error('expected tool_call block');
  input.input.command = 'MUTATED';
  input.input.flags.a = false;
  const live = s.getMessages()[0].content[0];
  if (live.type !== 'tool_call') throw new Error('expected tool_call block');
  assert.equal(live.input.command, 'ls');
  assert.equal(live.input.flags.a, true);
});
