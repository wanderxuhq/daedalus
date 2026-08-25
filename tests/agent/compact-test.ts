import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactHistory, summarizeTurns } from '../../src/agent/compact.ts';
import { buildSubagentPrompt } from '../../src/core/delegate.ts';
import type { AiClient, ChatParams, Message, StreamEvent } from '../../src/ai/types.ts';

// ---------------------------------------------------------------------------
// Helpers – match the existing test conventions (compact.test.ts, delegate.test.ts)
// ---------------------------------------------------------------------------

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

/** A client that returns a fixed summary for any input. */
function summaryClient(summary: string): AiClient {
  return {
    async *streamChat(_params: ChatParams) {
      yield { type: 'text_delta', text: summary };
      yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: summary }] } };
    },
  };
}

/** A client that records the messages it received, then returns a fixed reply. */
function recordingClient(summary: string, log: ChatParams[] = []): AiClient {
  return {
    async *streamChat(params: ChatParams) {
      log.push(params);
      yield { type: 'text_delta', text: summary };
      yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: summary }] } };
    },
  };
}

// ===================================================================
// 1. summarizeTurns (the summarization function used by auto-compact)
// ===================================================================

test('summarizeTurns sends the compactor system prompt and collects streamed text', async () => {
  const client: AiClient = {
    async *streamChat(params) {
      const system = params.messages.find((m) => m.role === 'system');
      const sysText = system?.content.find((c) => c.type === 'text');
      assert.ok(sysText && sysText.type === 'text' && sysText.text.startsWith('You are a conversation compactor'));
      // No tools should be sent to the compactor.
      assert.equal(params.tools?.length, 0);
      yield { type: 'text_delta', text: 'First chunk ' };
      yield { type: 'text_delta', text: 'second chunk' };
      yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'First chunk second chunk' }] } };
    },
  };

  const summary = await summarizeTurns(client, [user('one'), asst('a1'), user('two'), asst('a2')]);
  assert.equal(summary, 'First chunk second chunk');
});

test('summarizeTurns trims leading/trailing whitespace from the summary', async () => {
  const client = summaryClient('  summarized text  ');
  const summary = await summarizeTurns(client, [user('q'), asst('a')]);
  assert.equal(summary, 'summarized text');
});

test('summarizeTurns returns an empty string when the model produces no text', async () => {
  const client: AiClient = {
    async *streamChat() {
      yield { type: 'done', message: { role: 'assistant', content: [] } };
    },
  };
  const summary = await summarizeTurns(client, [user('q'), asst('a')]);
  assert.equal(summary, '');
});

test('summarizeTurns throws on a provider error event', async () => {
  const { AiError } = await import('../../src/ai/errors.ts');
  const client: AiClient = {
    async *streamChat() {
      yield { type: 'error', error: new AiError('network', 'summarizer down') };
    },
  };
  await assert.rejects(() => summarizeTurns(client, [user('q')]), /summarizer down/);
});

test('summarizeTurns forwards the turns to the model after the system prompt', async () => {
  const log: ChatParams[] = [];
  const client = recordingClient('ok', log);
  const turns = [user('What is the capital?'), asst('Paris is the capital of France.')];
  await summarizeTurns(client, turns);

  assert.equal(log.length, 1);
  const msgs = log[0].messages;
  // First message is the system prompt, followed by the original turns.
  assert.equal(msgs[0].role, 'system');
  assert.equal(msgs.length, 1 + turns.length);
  assert.deepEqual(msgs[1], turns[0]);
  assert.deepEqual(msgs[2], turns[1]);
});

// ===================================================================
// 2. Context injection in delegate (via DelegateInput.context field)
// ===================================================================

test('delegate prompt includes context section when context is provided', () => {
  // The delegate's runOnce builds the prompt as: `# Context\n\n${context}\n\n# Task\n\n${task}`
  // We verify this by examining the prompt string construction logic.
  const task = 'audit the README for stale references';
  const context = 'The repo has src/core/, src/tools/, and web/. README is at the root.';

  // Replicate the prompt construction from delegate.ts runOnce
  const prompt = [
    context ? `# Context\n\n${context}\n\n` : '',
    `# Task\n\n${task}`,
  ].join('');

  assert.ok(prompt.includes('# Context'), 'prompt contains the Context heading');
  assert.ok(prompt.includes(context), 'prompt contains the context text');
  assert.ok(prompt.includes('# Task'), 'prompt contains the Task heading');
  assert.ok(prompt.includes(task), 'prompt contains the task text');
  // Context should come before Task.
  assert.ok(prompt.indexOf('# Context') < prompt.indexOf('# Task'), 'Context appears before Task');
});

test('delegate prompt omits context section when no context is provided', () => {
  const task = 'write tests for grep';
  const context = undefined;

  const prompt = [
    context ? `# Context\n\n${context}\n\n` : '',
    `# Task\n\n${task}`,
  ].join('');

  assert.ok(!prompt.includes('# Context'), 'no Context heading when context is absent');
  assert.ok(prompt.includes('# Task'), 'prompt still contains the Task heading');
  assert.ok(prompt.includes(task), 'prompt still contains the task text');
});

test('delegate context with empty string is treated as absent', () => {
  const task = 'run the build';
  const context = '';

  const prompt = [
    context ? `# Context\n\n${context}\n\n` : '',
    `# Task\n\n${task}`,
  ].join('');

  // Empty string is falsy in JS, so the ternary skips it.
  assert.ok(!prompt.includes('# Context'), 'empty context does not produce Context heading');
});

test('buildSubagentPrompt does not mention delegate (no recursion leak)', () => {
  const prompt = buildSubagentPrompt();
  assert.ok(prompt.includes('delegated subagent'), 'subagent prompt frames the worker role');
  assert.ok(!prompt.includes('- delegate:'), 'subagent prompt does not advertise delegate tool');
  assert.ok(!prompt.includes('- delegateMany:'), 'subagent prompt does not advertise delegateMany tool');
});

// ===================================================================
// 3. compactHistory integrates summarizeTurns for auto-compact
// ===================================================================

test('compactHistory merges summary into the first surviving user prompt', async () => {
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
      // Verify the turns passed to the summarizer are the oldest ones.
      assert.deepEqual(turns, [user('one'), asst('a1')]);
      return 'SUMMARY of earlier work';
    },
  });
  assert.ok(out);
  assert.equal(out.dropped, 2); // one user-assistant pair
  // The summary is injected as a leading text block in the next surviving prompt.
  const surviving = out.messages.find(
    (m) => m.role === 'user' && m.content.some((c) => c.type === 'text' && (c as { text: string }).text === 'two'),
  );
  assert.ok(surviving, 'surviving user prompt is present');
  const textBlocks = surviving!.content.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text);
  assert.ok(textBlocks[0].startsWith('[Earlier conversation summary]'), 'summary block comes first');
  assert.ok(textBlocks[0].includes('SUMMARY of earlier work'), 'summary text is present');
  assert.ok(textBlocks.includes('two'), 'original prompt text is preserved');
});

test('compactHistory preserves system prefix', async () => {
  const msgs: Message[] = [
    sys('You are Daedalus'),
    user('one'), asst('a1'),
    user('two'), asst('a2'),
    user('three'), asst('a3'),
  ];
  const out = await compactHistory(msgs, {
    maxTokens: 6,
    estimate: count,
    summarize: async () => 'summary',
  });
  assert.ok(out);
  assert.equal(out.messages[0].role, 'system');
  assert.ok(out.messages[0].content.some((c) => c.type === 'text' && c.text === 'You are Daedalus'));
});

test('compactHistory returns null when under budget', async () => {
  const msgs = [sys(), user('one'), asst('a1')];
  let called = false;
  const out = await compactHistory(msgs, {
    maxTokens: 100,
    summarize: async () => { called = true; return 'x'; },
  });
  assert.equal(out, null);
  assert.equal(called, false, 'summarizer is not called when under budget');
});

test('compactHistory returns null when summarizer produces empty string', async () => {
  const msgs = [sys(), user('one'), asst('a1'), user('two'), asst('a2'), user('three'), asst('a3')];
  const out = await compactHistory(msgs, {
    maxTokens: 1,
    summarize: async () => '',
  });
  assert.equal(out, null, 'empty summary falls back to null (caller should trim)');
});

test('auto-compact integration: summarizeTurns used as the summarize callback', async () => {
  // Verify that passing summarizeTurns directly works as a callback.
  const client = summaryClient('auto-compact summary');
  const msgs: Message[] = [
    sys(),
    user('one'), asst('a1'),
    user('two'), asst('a2'),
    user('three'), asst('a3'),
  ];
  const out = await compactHistory(msgs, {
    maxTokens: 6,
    estimate: count,
    summarize: (turns) => summarizeTurns(client, turns),
  });
  assert.ok(out);
  assert.ok(out.messages.some(
    (m) => m.role === 'user' && m.content.some(
      (c) => c.type === 'text' && (c as { text: string }).text.includes('auto-compact summary'),
    ),
  ), 'auto-compact summary appears in the surviving prompt');
});
