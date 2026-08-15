import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDelegateTool, buildSubagentPrompt } from '../../src/core/delegate.ts';
import { runAgent } from '../../src/agent/loop.ts';
import { Session } from '../../src/core/session.ts';
import { AiError } from '../../src/ai/errors.ts';
import type { AiClient, ChatParams, Message, StreamEvent, ToolDefinition } from '../../src/ai/types.ts';
import type { Tool } from '../../src/tools/types.ts';

const ALLOW_ALL = (async () => true) as (action: string, target: string) => Promise<boolean>;

function echoTool(name: string): Tool {
  return {
    name,
    description: 'echo',
    inputSchema: { type: 'object' },
    async execute(input: unknown) {
      const args = input as { text?: string };
      return { content: `echo:${args.text ?? ''}` };
    },
  };
}

/** Records every streamChat call; each call plays the next scripted step (last repeats). */
function scriptedClient(
  steps: Array<(params: ChatParams) => AsyncGenerator<StreamEvent>>,
  log: { messages: Message[]; tools: ToolDefinition[] | undefined }[] = [],
): AiClient {
  let call = 0;
  return {
    async *streamChat(params: ChatParams) {
      log.push({ messages: params.messages, tools: params.tools });
      yield* steps[Math.min(call++, steps.length - 1)](params);
    },
  };
}

const toolNames = (params: ChatParams): string[] => (params.tools ?? []).map((t) => t.name);

function makeDelegate(opts?: { client?: AiClient; tools?: Tool[]; maxContextTokens?: number }) {
  const cwd = process.cwd();
  const availableTools = opts?.tools ?? [echoTool('grep'), echoTool('bash')];
  const client = opts?.client;
  return {
    tool: createDelegateTool({
      client: client ?? scriptedClient([]),
      cwd,
      askPermission: () => ALLOW_ALL,
      availableTools,
      maxContextTokens: opts?.maxContextTokens,
    }),
    availableTools,
  };
}

test('delegate runs the task in a separate session and returns only the report', async () => {
  const log: { messages: Message[]; tools: ToolDefinition[] | undefined }[] = [];
  const client = scriptedClient([
    // main agent: delegates
    async function* () {
      yield { type: 'tool_call_start', id: 'd1', name: 'delegate' };
      yield { type: 'tool_call_delta', id: 'd1', inputDelta: '{"task":"write tests for grep"}' };
      yield { type: 'done', message: { role: 'assistant', content: [{ type: 'tool_call', id: 'd1', name: 'delegate', input: { task: 'write tests for grep' } }] } };
    },
    // subagent: completes the task, reports back
    async function* () {
      yield { type: 'text_delta', text: 'added 3 tests to tests/tools/grep.test.ts' };
      yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'added 3 tests to tests/tools/grep.test.ts' }] } };
    },
    // main agent: wraps up
    async function* () {
      yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'all done' }] } };
    },
  ], log);

  const { tool, availableTools } = makeDelegate({ client });
  const session = new Session();
  session.start();
  session.addMessage({ role: 'user', content: [{ type: 'text', text: 'OLD main-context message' }] });

  const result = await runAgent({ client, session, prompt: 'help me', tools: [tool, ...availableTools], cwd: '.', askPermission: async () => true });
  assert.equal(result, 'all done');

  // The main session saw ONE tool_result (the delegate report) — no subagent steps.
  const mainBlocks = session.getMessages().flatMap((m) => m.content);
  const toolResults = mainBlocks.filter((c) => c.type === 'tool_result');
  assert.equal(toolResults.length, 1);
  assert.equal((toolResults[0] as { content: string }).content, 'added 3 tests to tests/tools/grep.test.ts');

  // Subagent context is isolated: its history is system + task, no main history.
  assert.equal(log.length, 3);
  const subMessages = log[1].messages;
  assert.ok(subMessages.some((m) => m.role === 'system' && m.content.some((c) => c.type === 'text')));
  const subText = subMessages.filter((m) => m.role === 'user').flatMap((m) => m.content).filter((c) => c.type === 'text').map((c) => (c as { text: string }).text).join('\n');
  assert.ok(subText.includes('# Task'));
  assert.ok(subText.includes('write tests for grep'));
  assert.ok(!subText.includes('OLD main-context message'));
});

test('delegate default subagent prompt frames the worker role', () => {
  const prompt = buildSubagentPrompt();
  assert.ok(prompt.includes('delegated subagent'));
  assert.ok(prompt.includes('concise report'));
  // The subagent has no delegate tool — its prompt must not advertise one.
  assert.ok(!prompt.includes('- delegate:'));
});

test('delegate restricts subagent tools by name', async () => {
  const log: { messages: Message[]; tools: ToolDefinition[] | undefined }[] = [];
  const client = scriptedClient([
    async function* () {
      yield { type: 'done', message: { role: 'assistant', content: [{ type: 'tool_call', id: 'd', name: 'delegate', input: { task: 'T', tools: ['grep'] } }] } };
    },
    async function* () {
      yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } };
    },
    async function* () {
      yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } };
    },
  ], log);

  const { tool } = makeDelegate({ client });
  await runAgent({ client, session: freshSession(), prompt: 'p', tools: [tool], cwd: '.', askPermission: async () => true });
  assert.deepEqual(toolNames(log[1]), ['grep']);
});

test('delegate never hands the delegate tool to a subagent (no recursion)', async () => {
  const log: { messages: Message[]; tools: ToolDefinition[] | undefined }[] = [];
  const client = scriptedClient([
    async function* () {
      yield { type: 'done', message: { role: 'assistant', content: [{ type: 'tool_call', id: 'd', name: 'delegate', input: { task: 'T' } }] } };
    },
    async function* () {
      yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } };
    },
    async function* () {
      yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } };
    },
  ], log);

  const { tool } = makeDelegate({ client });
  await runAgent({ client, session: freshSession(), prompt: 'p', tools: [tool], cwd: '.', askPermission: async () => true });
  assert.deepEqual(toolNames(log[1]), ['grep', 'bash']);
  assert.ok(!toolNames(log[1]).includes('delegate'));
});

test('delegate truncates oversized reports to protect the main context', async () => {
  const longReport = 'x'.repeat(5000);
  const client = scriptedClient([
    async function* () {
      yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: longReport }] } };
    },
  ]);
  const { tool } = makeDelegate({ client });
  const res = await tool.execute({ task: 'T', maxResultChars: 100 }, { cwd: '.', askPermission: async () => true });
  assert.ok(res.content.startsWith('x'.repeat(100)));
  assert.ok(res.content.includes('…[report truncated: exceeded 100 chars]'));
  assert.ok(res.content.length < 200, 'report is bounded near the cap');
});

test('delegate surfaces a failing subagent as an error result, not a crash', async () => {
  const client = scriptedClient([
    async function* () {
      yield { type: 'error', error: new AiError('server', 'model exploded') };
    },
  ]);
  const { tool } = makeDelegate({ client });
  const res = await tool.execute({ task: 'T' }, { cwd: '.', askPermission: async () => true });
  assert.equal(res.isError, true);
  assert.ok(res.content.includes('Subagent failed'));
  assert.ok(res.content.includes('model exploded'));
});

test('delegate requires a task', async () => {
  const { tool } = makeDelegate();
  const res = await tool.execute({}, { cwd: '.', askPermission: async () => true });
  assert.equal(res.isError, true);
  assert.ok(res.content.includes('task'));
});

test('engine end-to-end: a delegated task leaves no subagent steps in the main session', async () => {
  const { DaedalusEngine } = await import('../../src/core/engine.ts');
  const log: { messages: Message[] }[] = [];
  const client = scriptedClient([
    // main agent delegates
    async function* () {
      yield { type: 'done', message: { role: 'assistant', content: [{ type: 'tool_call', id: 'd', name: 'delegate', input: { task: 'audit the README', tools: ['grep', 'read'] } }] } };
    },
    // subagent works in its own session, reports back
    async function* (params) {
      log.push({ messages: params.messages });
      yield { type: 'text_delta', text: 'README accurate; fixed 1 stale flag reference' };
      yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'README accurate; fixed 1 stale flag reference' }] } };
    },
    // main agent concludes
    async function* () {
      yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'docs audited' }] } };
    },
  ]);

  const engine = new DaedalusEngine({
    client,
    cwd: process.cwd(),
    askPermission: (async () => true) as (action: string, target: string) => Promise<boolean>,
    skillDirs: [],
    maxIterations: 5,
  });
  const result = await engine.run('audit the docs');
  assert.equal(result, 'docs audited');

  const msgs = engine.getSessionState().messages;
  assert.equal(msgs.length, 5); // system + prompt + delegate call + tool_result + final
  const roles = msgs.map((m) => m.role);
  assert.deepEqual(roles, ['system', 'user', 'assistant', 'user', 'assistant']);
  const toolResult = msgs[3].content.find((c) => c.type === 'tool_result') as { content: string } | undefined;
  assert.ok(toolResult);
  assert.equal(toolResult.content, 'README accurate; fixed 1 stale flag reference');
  // No subagent internals leaked into the main session: exactly one tool_result, no sub-tool noise.
  assert.equal(msgs.flatMap((m) => m.content).filter((c) => c.type === 'tool_result').length, 1);

  // The subagent truly got its own system prompt + task (isolation at the client level).
  assert.equal(log.length, 1);
  const subText = log[0].messages.flatMap((m) => m.content).filter((c) => c.type === 'text').map((c) => (c as { text: string }).text).join('\n');
  assert.ok(subText.includes('# Task'));
  assert.ok(subText.includes('audit the README'));
  await engine.dispose();
});

test('delegate resolves the permission handler at call time (REPL setAskPermission applies to subagents)', async () => {
  let current: (action: string, target: string) => Promise<boolean> = async () => false;
  const seen: string[] = [];
  const permissionTool: Tool = {
    name: 'asky',
    description: 'asky',
    inputSchema: { type: 'object' },
    async execute(_input, ctx) {
      seen.push((await ctx.askPermission('x', 'y')) ? 'granted' : 'denied');
      return { content: 'ok' };
    },
  };
  const client = scriptedClient([
    async function* () {
      yield { type: 'done', message: { role: 'assistant', content: [{ type: 'tool_call', id: 'a', name: 'asky', input: {} }] } };
    },
    async function* () {
      yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } };
    },
  ]);
  const tool = createDelegateTool({ client, cwd: '.', askPermission: () => current, availableTools: [permissionTool] });
  // Handler swapped AFTER construction — exactly what REPL setAskPermission does.
  current = async () => true;
  const res = await tool.execute({ task: 'T' }, { cwd: '.', askPermission: async () => false });
  assert.equal(res.content, 'done');
  assert.deepEqual(seen, ['granted']);
});

function freshSession(): Session {
  const s = new Session();
  s.start();
  return s;
}
