import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateTokens, trimHistory } from '../../src/agent/context.ts';
import type { Message } from '../../src/ai/types.ts';

function sys(text = 'sys'): Message {
  return { role: 'system', content: [{ type: 'text', text }] };
}
function user(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }] };
}
function asst(text: string): Message {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}
const count = (msgs: Message[]): number => msgs.length;

test('estimateTokens counts per-message, per-block, and per-char overhead', () => {
  assert.equal(estimateTokens([]), 0);
  assert.equal(estimateTokens([{ role: 'user', content: [{ type: 'text', text: 'abcd' }] }]), 7); // 4 + ceil(4/4) + 2
  assert.equal(estimateTokens([{ role: 'assistant', content: [{ type: 'tool_call', id: 't', name: 'bash', input: { command: 'ls' } }] }]), 10); // 4 + ceil(14/4) + 2
  assert.equal(estimateTokens([{ role: 'user', content: [{ type: 'tool_result', toolCallId: 't', content: '0123456789abcdef' }] }]), 10); // 4 + ceil(16/4) + 2
});

test('keeps the system prefix and drops oldest whole turns', () => {
  const msgs: Message[] = [sys(), user('one'), asst('a1'), user('two'), asst('a2'), user('three'), asst('a3'), user('four'), asst('a4')];
  const out = trimHistory(msgs, { maxTokens: 7, estimate: count });
  assert.equal(out[0].role, 'system');
  assert.ok(out.some((m) => m.content.some((c) => c.type === 'text' && c.text === 'two')));
  assert.ok(!out.some((m) => m.content.some((c) => c.type === 'text' && c.text === 'one')));
});

test('never splits a tool_call from its tool_result', () => {
  const msgs: Message[] = [
    sys(),
    user('q1'), { role: 'assistant', content: [{ type: 'tool_call', id: 't1', name: 'bash', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', toolCallId: 't1', content: 'out' }] },
    user('q2'), asst('a2'),
    user('q3'), asst('a3'),
  ];
  const out = trimHistory(msgs, { maxTokens: 6, estimate: count });
  // The whole first turn (prompt + tool_call + tool_result) is dropped together.
  assert.ok(!out.some((m) => m.content.some((c) => c.type === 'tool_result')));
  assert.ok(!out.some((m) => m.content.some((c) => c.type === 'text' && c.text === 'q1')));
});

test('a protected skill-body message pulls the cut back to keep its turn', () => {
  const msgs: Message[] = [
    sys(),
    user('one'), { role: 'user', content: [{ type: 'text', text: '[Skill: review]\n\nBody' }] },
    user('two'), asst('a2'),
    user('three'), asst('a3'),
  ];
  const out = trimHistory(msgs, { maxTokens: 5, estimate: count });
  // The unprotected turn 'one' is dropped; the protected skill turn is kept whole
  // (the cut pulled back from 2 to 1), and everything after it stays.
  assert.notEqual(out, msgs);
  assert.ok(!out.some((m) => m.content.some((c) => c.type === 'text' && c.text === 'one')));
  assert.ok(out.some((m) => m.content.some((c) => c.type === 'text' && c.text.startsWith('[Skill: review]'))));
  assert.ok(out.some((m) => m.content.some((c) => c.type === 'text' && c.text === 'two')));
  assert.ok(out.some((m) => m.content.some((c) => c.type === 'text' && c.text === 'three')));
});

test('MIN_KEEP_TURNS floor keeps at least two turns', () => {
  const msgs: Message[] = [sys(), user('one'), asst('a1'), user('two'), asst('a2'), user('three'), asst('a3'), user('four'), asst('a4')];
  const out = trimHistory(msgs, { maxTokens: 1, estimate: count });
  const prompts = out
    .filter((m) => m.role === 'user' && m.content.some((c) => c.type === 'text'))
    .map((m) => (m.content[0].type === 'text' ? m.content[0].text : ''));
  assert.deepEqual(prompts, ['three', 'four']);
});

test('a single over-budget turn is not trimmed (budget is advisory)', () => {
  const msgs: Message[] = [sys(), user('huge'), asst('big answer')];
  const out = trimHistory(msgs, { maxTokens: 1, estimate: count });
  assert.equal(out, msgs);
});

test('returns the same reference when under budget', () => {
  const msgs: Message[] = [sys(), user('one'), asst('a1'), user('two'), asst('a2')];
  const out = trimHistory(msgs, { maxTokens: 100, estimate: count });
  assert.equal(out, msgs);
});

test('isProtected can be overridden', () => {
  const msgs: Message[] = [sys(), user('one'), asst('a1'), user('two'), asst('a2'), user('three'), asst('a3')];
  const out = trimHistory(msgs, { maxTokens: 5, estimate: count });
  assert.ok(!out.some((m) => m.content.some((c) => c.type === 'text' && c.text === 'one')));
  const kept = trimHistory(msgs, {
    maxTokens: 5,
    estimate: count,
    isProtected: (m) => m.content.some((c) => c.type === 'text' && c.text === 'a1'),
  });
  assert.ok(kept.some((m) => m.content.some((c) => c.type === 'text' && c.text === 'one')));
});

test('no user prompts and empty history return the input unchanged', () => {
  const onlyToolResults: Message[] = [sys(), { role: 'user', content: [{ type: 'tool_result', toolCallId: 't', content: 'x' }] }];
  assert.equal(trimHistory(onlyToolResults, { maxTokens: 1, estimate: count }), onlyToolResults);
  const empty: Message[] = [];
  assert.equal(trimHistory(empty, { maxTokens: 1 }), empty);
});

test('default isProtected recognizes [Skill: markers in text and tool_result blocks', () => {
  // A tool_result-marker skill sits inside turn 0. The budget would drop that turn,
  // so the tool_result must pull the cut back to 0 — no trim at all.
  const resultSkill: Message = { role: 'user', content: [{ type: 'tool_result', toolCallId: 't', content: '[Skill: fix]\n\nDo fixes' }] };
  const msgs: Message[] = [
    sys(), user('p1'), asst('a1'), resultSkill, asst('a2'),
    user('p2'), asst('a3'), user('p3'), asst('a4'),
  ];
  const out = trimHistory(msgs, { maxTokens: 4, estimate: count });
  assert.equal(out, msgs); // pull-back to 0: whole history kept
  assert.ok(out.some((m) => m === resultSkill));
  // A text-marker skill in a later turn survives trimming while an unprotected
  // earlier turn is dropped (recognition is what keeps the skill).
  const textSkill: Message = { role: 'user', content: [{ type: 'text', text: '[Skill: fix]\n\nDo fixes' }] };
  const msgs2: Message[] = [sys(), user('q1'), asst('b1'), textSkill, asst('b2'), user('q2'), asst('b3')];
  const out2 = trimHistory(msgs2, { maxTokens: 4, estimate: count });
  assert.notEqual(out2, msgs2);
  assert.ok(!out2.some((m) => m.content.some((c) => c.type === 'text' && c.text === 'q1')));
  assert.ok(out2.some((m) => m === textSkill));
  assert.ok(out2.some((m) => m.content.some((c) => c.type === 'text' && c.text === 'q2')));
});
