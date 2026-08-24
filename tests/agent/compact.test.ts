import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactHistory, summarizeTurns, summarizeMainForTask } from '../../src/agent/compact.ts';
import type { Message } from '../../src/ai/types.ts';
import type { AiClient } from '../../src/ai/types.ts';

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

test('compacts oldest turns into a summary merged into the next prompt', async () => {
  const msgs: Message[] = [
    sys(),
    user('one'), asst('a1'),
    user('two'), asst('a2'),
    user('three'), asst('a3'),
  ];
  const out = await compactHistory(msgs, {
    maxTokens: 6,
    estimate: count,
    summarize: async (turns) => {
      // MIN_KEEP_TURNS floor: only the oldest turn (of 3) is compactable.
      assert.deepEqual(turns, msgs.slice(1, 3));
      return 'SUMMARY TEXT';
    },
  });
  assert.ok(out);
  const next = out.messages[1];
  assert.equal(next.role, 'user');
  const texts = next.content.filter((c) => c.type === 'text').map((c) => (c.type === 'text' ? c.text : ''));
  assert.ok(texts[0].startsWith('[Earlier conversation summary]'));
  assert.ok(texts[0].includes('SUMMARY TEXT'));
  assert.ok(texts.some((t) => t === 'two'));
  assert.equal(out.dropped, 2); // one turn × 2 messages
  // Roles still alternate after the merge.
  for (let i = 1; i < out.messages.length; i++) {
    assert.notEqual(out.messages[i].role, out.messages[i - 1].role);
  }
});

test('returns null when under budget (nothing to compact)', async () => {
  const msgs: Message[] = [sys(), user('one'), asst('a1')];
  let summarized = false;
  const out = await compactHistory(msgs, {
    maxTokens: 100,
    summarize: async () => { summarized = true; return 'x'; },
  });
  assert.equal(out, null);
  assert.equal(summarized, false);
});

test('returns null when the summarizer produces nothing', async () => {
  const msgs: Message[] = [sys(), user('one'), asst('a1'), user('two'), asst('a2'), user('three'), asst('a3')];
  const out = await compactHistory(msgs, { maxTokens: 1, summarize: async () => '' });
  assert.equal(out, null);
});

test('protected skill turns pull the cut back (same protection as trim)', async () => {
  const msgs: Message[] = [
    sys(),
    user('one'), asst('a1'),
    user('two'), asst('a2'),
    { role: 'user', content: [{ type: 'text', text: '[Skill: review]\n\nBody' }] }, asst('a3'),
    user('four'), asst('a4'),
  ];
  let summarizedTurns: Message[] | null = null;
  const out = await compactHistory(msgs, {
    maxTokens: 5,
    estimate: count,
    summarize: async (turns) => { summarizedTurns = turns; return 'S'; },
  });
  assert.ok(out);
  // The cut stops before the skill turn, so only the two unprotected turns are
  // summarized away; the skill body survives whole, merged with the summary.
  assert.deepEqual(summarizedTurns, [user('one'), asst('a1'), user('two'), asst('a2')]);
  const all = JSON.stringify(out.messages);
  assert.ok(all.includes('[Skill: review]'));
  assert.ok(all.includes('four'));
  assert.ok(!all.includes('"one"'));
  assert.ok(!all.includes('"two"'));
});

test('MIN_KEEP_TURNS floor applies: the summary replaces all but the last two turns', async () => {
  const msgs: Message[] = [sys(), user('one'), asst('a1'), user('two'), asst('a2'), user('three'), asst('a3'), user('four'), asst('a4')];
  const out = await compactHistory(msgs, { maxTokens: 1, estimate: count, summarize: async () => 'S' });
  assert.ok(out);
  const prompts = out.messages
    .filter((m) => m.role === 'user')
    .map((m) => m.content.filter((c) => c.type === 'text').map((c) => (c.type === 'text' ? c.text : '')));
  // First user message = merged summary + prompt 'three'; last = 'four'.
  assert.ok(prompts[0][0].includes('S'));
  assert.ok(prompts[0].some((t) => t === 'three'));
  assert.ok(prompts[1].some((t) => t === 'four'));
});

test('empty history / no prompts → null', async () => {
  assert.equal(await compactHistory([], { maxTokens: 1, summarize: async () => 'x' }), null);
  const toolResultsOnly: Message[] = [sys(), { role: 'user', content: [{ type: 'tool_result', toolCallId: 't', content: 'x' }] }];
  assert.equal(await compactHistory(toolResultsOnly, { maxTokens: 1, summarize: async () => 'x' }), null);
});

test('summarizeTurns sends the compactor system prompt and collects text', async () => {
  const client: AiClient = {
    async *streamChat(params) {
      const system = params.messages.find((m) => m.role === 'system');
      const sysText = system?.content.find((c) => c.type === 'text');
      assert.ok(sysText && sysText.type === 'text' && sysText.text.startsWith('You are a conversation compactor'));
      assert.equal(params.tools?.length, 0);
      yield { type: 'text_delta', text: 'SUM' };
      yield { type: 'text_delta', text: 'MARY' };
      yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'SUMMARY' }] } };
    },
  };
  const summary = await summarizeTurns(client, [user('one'), asst('a1')]);
  assert.equal(summary, 'SUMMARY');
});

test('summarizeTurns throws on a provider error event', async () => {
  const { AiError } = await import('../../src/ai/errors.ts');
  const client: AiClient = {
    async *streamChat() {
      yield { type: 'error', error: new AiError('network', 'boom') };
    },
  };
  await assert.rejects(() => summarizeTurns(client, [user('x')]), /boom/);
});

// Tests for summarizeMainForTask

test('summarizeMainForTask returns empty string for empty history', async () => {
  const client: AiClient = {
    async *streamChat() {
      yield { type: 'text_delta', text: 'should not be called' };
    },
  };
  const summary = await summarizeMainForTask(client, [], 'test task');
  assert.equal(summary, '');
});

test('summarizeMainForTask sends task-specific system prompt', async () => {
  const task = 'Analyze the performance of function X';
  const client: AiClient = {
    async *streamChat(params) {
      const system = params.messages.find((m) => m.role === 'system');
      const sysText = system?.content.find((c) => c.type === 'text');
      assert.ok(sysText && sysText.type === 'text');
      assert.ok(sysText.text.includes('conversation summarizer'));
      assert.ok(sysText.text.includes(task));
      yield { type: 'text_delta', text: 'Task summary' };
    },
  };
  const summary = await summarizeMainForTask(client, [user('hello')], task);
  assert.equal(summary, 'Task summary');
});

test('summarizeMainForTask forwards main history to model', async () => {
  const mainHistory: Message[] = [user('first message'), asst('response 1'), user('second message')];
  const client: AiClient = {
    async *streamChat(params) {
      // Check that main history is included after system prompt
      const nonSystemMessages = params.messages.filter((m) => m.role !== 'system');
      assert.equal(nonSystemMessages.length, mainHistory.length);
      assert.deepEqual(nonSystemMessages, mainHistory);
      yield { type: 'text_delta', text: 'summary' };
    },
  };
  const summary = await summarizeMainForTask(client, mainHistory, 'test task');
  assert.equal(summary, 'summary');
});

test('summarizeMainForTask trims whitespace from summary', async () => {
  const client: AiClient = {
    async *streamChat() {
      yield { type: 'text_delta', text: '  summary with spaces  ' };
    },
  };
  const summary = await summarizeMainForTask(client, [user('hello')], 'task');
  assert.equal(summary, 'summary with spaces');
});

test('summarizeMainForTask throws on provider error', async () => {
  const { AiError } = await import('../../src/ai/errors.ts');
  const client: AiClient = {
    async *streamChat() {
      yield { type: 'error', error: new AiError('network', 'summary failed') };
    },
  };
  await assert.rejects(
    () => summarizeMainForTask(client, [user('hello')], 'task'),
    /summary failed/
  );
});
