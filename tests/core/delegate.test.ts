import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDelegateTool, createDelegateManyTool, buildSubagentPrompt } from '../../src/core/delegate.ts';
import { runAgent } from '../../src/agent/loop.ts';
import { Session, SessionPool } from '../../src/core/session.ts';
import { AiError } from '../../src/ai/errors.ts';
import type { AiClient, ChatParams, Message, StreamEvent, ToolDefinition } from '../../src/ai/types.ts';
import type { Tool } from '../../src/tools/types.ts';
import type { CoreEvent } from '../../src/core/events.ts';

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

// ---------------------------------------------------------------------------
// Subagent enhancements: nested delegation, fan-out, session reuse, retries,
// JSON reports, event forwarding, cancellation and signal propagation.
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Client that answers from the task text, so parallel lanes are order-independent. */
function taskClient(map: Record<string, string>): AiClient {
  return {
    async *streamChat(params: ChatParams) {
      const text = params.messages
        .flatMap((m) => m.content)
        .filter((c) => c.type === 'text')
        .map((c) => (c as { text: string }).text)
        .join('\n');
      for (const [needle, out] of Object.entries(map)) {
        if (text.includes(needle)) {
          yield { type: 'text_delta', text: out };
          yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: out }] } };
          return;
        }
      }
      yield { type: 'error', error: new AiError('server', 'no scripted match for task') };
    },
  };
}

const textOf = (messages: Message[]): string =>
  messages
    .flatMap((m) => m.content)
    .filter((c) => c.type === 'text')
    .map((c) => (c as { text: string }).text)
    .join('\n');

test('delegate maxDepth 2 lets subagents spawn their own subagents (nested delegation)', async () => {
  const log: { messages: Message[]; tools: ToolDefinition[] | undefined }[] = [];
  const client = scriptedClient([
    // main → subagent
    async function* () {
      yield { type: 'done', message: { role: 'assistant', content: [{ type: 'tool_call', id: 'd1', name: 'delegate', input: { task: 'child task' } }] } };
    },
    // subagent → grandchild
    async function* () {
      yield { type: 'done', message: { role: 'assistant', content: [{ type: 'tool_call', id: 'd2', name: 'delegate', input: { task: 'grandchild task' } }] } };
    },
    // grandchild reports
    async function* () {
      yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'grandchild report' }] } };
    },
    // subagent reports
    async function* () {
      yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'child report' }] } };
    },
    // main concludes
    async function* () {
      yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } };
    },
  ], log);

  const tool = createDelegateTool({
    client,
    cwd: '.',
    askPermission: () => ALLOW_ALL,
    availableTools: [echoTool('grep'), echoTool('bash')],
    maxDepth: 2,
  });
  const session = freshSession();
  await runAgent({ client, session, prompt: 'p', tools: [tool], cwd: '.', askPermission: async () => true });
  const results = session.getMessages().flatMap((m) => m.content).filter((c) => c.type === 'tool_result');
  assert.equal(results.length, 1);
  // The subagent's report arrives as the content of that single tool_result —
  // textOf only collects plain text blocks, so check the block directly.
  assert.ok(String(results[0].content).includes('child report'));

  // The subagent (depth 1) got its own delegate + delegateMany alongside the builtins.
  const subTools = toolNames(log[1]);
  assert.ok(subTools.includes('delegate'));
  assert.ok(subTools.includes('delegateMany'));
  assert.ok(subTools.includes('grep') && subTools.includes('bash'));
  // The grandchild (depth 2) hit the cap: no delegation tools.
  const grandTools = toolNames(log[2]);
  assert.ok(!grandTools.includes('delegate'));
  assert.ok(!grandTools.includes('delegateMany'));
  assert.ok(grandTools.includes('grep') && grandTools.includes('bash'));
});

test('delegateMany runs independent tasks in parallel subagents and merges reports', async () => {
  const client = taskClient({ 'task A': 'result A', 'task B': 'result B' });
  const tool = createDelegateManyTool({ client, cwd: '.', askPermission: () => ALLOW_ALL, availableTools: [] });
  const res = await tool.execute(
    { tasks: [{ task: 'task A' }, { task: 'task B' }] },
    { cwd: '.', askPermission: async () => true },
  );
  assert.equal(res.isError, false, 'all lanes succeeded — not an error');
  assert.ok(res.content.includes('## Subagent 1'));
  assert.ok(res.content.includes('result A'));
  assert.ok(res.content.includes('## Subagent 2'));
  assert.ok(res.content.includes('result B'));
});

test('delegateMany caps concurrency at maxConcurrent', async () => {
  let active = 0;
  let maxActive = 0;
  const client: AiClient = {
    async *streamChat() {
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        await sleep(15);
        yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } };
      } finally {
        active--;
      }
    },
  };
  const tool = createDelegateManyTool({ client, cwd: '.', askPermission: () => ALLOW_ALL, availableTools: [] });
  const res = await tool.execute(
    { tasks: [{ task: 't1' }, { task: 't2' }, { task: 't3' }, { task: 't4' }], maxConcurrent: 2 },
    { cwd: '.', askPermission: async () => true },
  );
  assert.equal(maxActive, 2, 'never more than maxConcurrent subagents in flight');
  assert.equal(res.isError, false, 'all lanes succeeded — not an error');
});

test('delegateMany degrades to partial results when some lanes fail', async () => {
  const client = taskClient({ 'ok task': 'OK result' });
  const tool = createDelegateManyTool({ client, cwd: '.', askPermission: () => ALLOW_ALL, availableTools: [] });
  const res = await tool.execute(
    { tasks: [{ task: 'ok task' }, { task: 'missing task' }] },
    { cwd: '.', askPermission: async () => true },
  );
  assert.ok(res.content.includes('OK result'));
  assert.ok(res.content.includes('## Subagent 2 (failed)'));
  assert.ok(res.content.includes('Subagent failed'));
  assert.equal(res.isError, false, 'partial results are still useful');
});

test('delegateMany fails only when every lane fails', async () => {
  const client = taskClient({});
  const tool = createDelegateManyTool({ client, cwd: '.', askPermission: () => ALLOW_ALL, availableTools: [] });
  const res = await tool.execute({ tasks: [{ task: 'x' }] }, { cwd: '.', askPermission: async () => true });
  assert.equal(res.isError, true);
});

test('delegateMany requires a non-empty tasks array', async () => {
  const tool = createDelegateManyTool({ client: scriptedClient([]), cwd: '.', askPermission: () => ALLOW_ALL, availableTools: [] });
  const res = await tool.execute({ tasks: [] }, { cwd: '.', askPermission: async () => true });
  assert.equal(res.isError, true);
  assert.ok(res.content.includes('tasks'));
});

test('delegate json mode asks the subagent for a JSON report', async () => {
  const prompt = buildSubagentPrompt({ json: true });
  assert.ok(prompt.includes('single valid JSON value'));
  assert.ok(prompt.includes('# Report format: JSON'));

  const log: { messages: Message[] }[] = [];
  const client = scriptedClient([
    async function* () {
      yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: '{"ok":true}' }] } };
    },
  ], log);
  const tool = createDelegateTool({ client, cwd: '.', askPermission: () => ALLOW_ALL, availableTools: [] });
  const res = await tool.execute({ task: 'T', json: true }, { cwd: '.', askPermission: async () => true });
  assert.equal(res.content, '{"ok":true}');
  assert.ok(textOf(log[0].messages).includes('single valid JSON value'));
});

test('delegate reuses a named agent session across calls (working memory)', async () => {
  const log: { messages: Message[] }[] = [];
  const client = scriptedClient([
    async function* () {
      yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'first report' }] } };
    },
    async function* () {
      yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'second report' }] } };
    },
  ], log);
  const pool = new SessionPool();
  const tool = createDelegateTool({ client, cwd: '.', askPermission: () => ALLOW_ALL, availableTools: [], sessions: pool });
  const ctx = { cwd: '.', askPermission: async () => true };
  assert.equal((await tool.execute({ task: 'first task', agent: 'researcher' }, ctx)).content, 'first report');
  assert.equal((await tool.execute({ task: 'second task', agent: 'researcher' }, ctx)).content, 'second report');
  // The second run carries the first run's history (task + report) and one system prompt.
  assert.ok(textOf(log[1].messages).includes('first task'));
  assert.ok(textOf(log[1].messages).includes('first report'));
  assert.ok(textOf(log[1].messages).includes('second task'));
  assert.equal(log[1].messages.filter((m) => m.role === 'system').length, 1);
  // A different name starts fresh.
  await tool.execute({ task: 'other task', agent: 'other' }, ctx);
  assert.ok(!textOf(log[2].messages).includes('first task'));
  pool.clear();
});

test('delegate retries a failing subagent up to the retries count', async () => {
  const client = scriptedClient([
    async function* () {
      yield { type: 'error', error: new AiError('server', 'model exploded') };
    },
    async function* () {
      yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'recovered' }] } };
    },
  ]);
  const { tool } = makeDelegate({ client });
  const res = await tool.execute({ task: 'T', retries: 1 }, { cwd: '.', askPermission: async () => true });
  assert.equal(res.isError, undefined);
  assert.equal(res.content, 'recovered');
});

test('delegate forwards subagent progress events via onEvent', async () => {
  const events: CoreEvent[] = [];
  const client = scriptedClient([
    async function* () {
      yield { type: 'text_delta', text: 'working on it' };
      yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'working on it' }] } };
    },
  ]);
  const tool = createDelegateTool({ client, cwd: '.', askPermission: () => ALLOW_ALL, availableTools: [], onEvent: (ev) => events.push(ev) });
  const res = await tool.execute({ task: 'T', agent: 'a1' }, { cwd: '.', askPermission: async () => true });
  assert.equal(res.content, 'working on it');
  assert.ok(events.some((e) => e.type === 'delegate_start' && e.agent === 'a1'));
  assert.ok(events.some((e) => e.type === 'text_delta' && e.text === 'working on it'));
});

test('delegate propagates cancellation as an interrupt, not a subagent failure', async () => {
  const client = scriptedClient([
    async function* () {
      yield { type: 'error', error: new AiError('timeout', 'request cancelled by user') };
    },
  ]);
  const { tool } = makeDelegate({ client });
  await assert.rejects(tool.execute({ task: 'T' }, { cwd: '.', askPermission: async () => true }));
});

test('delegate forwards the abort signal to the subagent client', async () => {
  const ac = new AbortController();
  let gotSignal: AbortSignal | undefined;
  const client: AiClient = {
    async *streamChat(params: ChatParams) {
      gotSignal = params.signal;
      yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } };
    },
  };
  const { tool } = makeDelegate({ client });
  await tool.execute({ task: 'T' }, { cwd: '.', askPermission: async () => true, signal: ac.signal });
  assert.equal(gotSignal, ac.signal);
});

// ---------------------------------------------------------------------------
// Background delegate mode tests
// ---------------------------------------------------------------------------

test('delegate background mode returns immediately without blocking', async () => {
  let subagentRunning = false;
  let subagentCompleted = false;
  const client: AiClient = {
    async *streamChat() {
      subagentRunning = true;
      await sleep(50); // Simulate work
      subagentCompleted = true;
      yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'background result' }] } };
    },
  };
  const tool = createDelegateTool({ client, cwd: '.', askPermission: () => ALLOW_ALL, availableTools: [] });
  const startTime = Date.now();
  const res = await tool.execute({ task: 'T', background: true }, { cwd: '.', askPermission: async () => true });
  const elapsed = Date.now() - startTime;
  // Should return quickly (not wait for the 50ms subagent work)
  assert.ok(elapsed < 30, 'background mode returns immediately');
  assert.ok(res.content.includes('子代理已启动'));
  assert.ok(res.content.includes('T'));
  // Subagent is still running
  assert.equal(subagentRunning, true);
  assert.equal(subagentCompleted, false);
  // Wait for subagent to complete
  await sleep(100);
  assert.equal(subagentCompleted, true);
});

test('delegate foreground mode blocks until subagent completes', async () => {
  let subagentCompleted = false;
  const client: AiClient = {
    async *streamChat() {
      await sleep(50); // Simulate work
      subagentCompleted = true;
      yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'foreground result' }] } };
    },
  };
  const tool = createDelegateTool({ client, cwd: '.', askPermission: () => ALLOW_ALL, availableTools: [] });
  const startTime = Date.now();
  const res = await tool.execute({ task: 'T' }, { cwd: '.', askPermission: async () => true });
  const elapsed = Date.now() - startTime;
  // Should wait for subagent to complete
  assert.ok(elapsed >= 40, 'foreground mode blocks until completion');
  assert.equal(subagentCompleted, true);
  assert.equal(res.content, 'foreground result');
});

test('delegate background mode emits error event on failure', async () => {
  const events: CoreEvent[] = [];
  const client: AiClient = {
    async *streamChat() {
      yield { type: 'error', error: new AiError('server', 'background failed') };
    },
  };
  const tool = createDelegateTool({ client, cwd: '.', askPermission: () => ALLOW_ALL, availableTools: [], onEvent: (ev) => events.push(ev) });
  await tool.execute({ task: 'T', background: true, agent: 'bg1' }, { cwd: '.', askPermission: async () => true });
  // Wait for background failure to propagate
  await sleep(50);
  assert.ok(events.some((e) => e.type === 'delegate_start' && e.agent === 'bg1'));
  assert.ok(events.some((e) => e.type === 'error' && e.agent === 'bg1'));
});

test('delegate background mode calls onSubagentStart/End callbacks (root cause fix)', async () => {
  const started: string[] = [];
  const ended: string[] = [];
  const client: AiClient = {
    async *streamChat() {
      yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } };
    },
  };
  const tool = createDelegateTool({
    client,
    cwd: '.',
    askPermission: () => ALLOW_ALL,
    availableTools: [],
    onSubagentStart: (name) => started.push(name),
    onSubagentEnd: (name) => ended.push(name),
  });
  await tool.execute({ task: 'T', background: true, agent: 'tracker' }, { cwd: '.', askPermission: async () => true });
  // Wait for background subagent to complete
  await sleep(100);
  assert.deepEqual(started, ['tracker'], 'onSubagentStart called with agent name');
  assert.deepEqual(ended, ['tracker'], 'onSubagentEnd called after completion');
});

// ---------------------------------------------------------------------------
// Session pending message queue tests
// ---------------------------------------------------------------------------

test('session pending message queue: drainPendingMessages returns true when messages exist', () => {
  const session = freshSession();
  session.addPendingMessage({ role: 'user', content: [{ type: 'text', text: 'pending message' }] });
  assert.equal(session.hasPendingMessages(), true);
  const drained = session.drainPendingMessages();
  assert.equal(drained, true);
  assert.equal(session.hasPendingMessages(), false);
  // Message should now be in the session history
  const msgs = session.getMessages();
  assert.ok(msgs.some((m) => m.role === 'user' && m.content.some((c) => c.type === 'text' && (c as { text: string }).text === 'pending message')));
});

test('session pending message queue: drainPendingMessages returns false when empty', () => {
  const session = freshSession();
  assert.equal(session.hasPendingMessages(), false);
  const drained = session.drainPendingMessages();
  assert.equal(drained, false);
});

test('session pending message queue: multiple messages are drained together', () => {
  const session = freshSession();
  session.addPendingMessage({ role: 'user', content: [{ type: 'text', text: 'msg1' }] });
  session.addPendingMessage({ role: 'user', content: [{ type: 'text', text: 'msg2' }] });
  session.addPendingMessage({ role: 'user', content: [{ type: 'text', text: 'msg3' }] });
  assert.equal(session.hasPendingMessages(), true);
  session.drainPendingMessages();
  assert.equal(session.hasPendingMessages(), false);
  // All messages should be in the session history
  const msgs = session.getMessages();
  assert.ok(msgs.some((m) => m.content.some((c) => c.type === 'text' && (c as { text: string }).text === 'msg1')));
  assert.ok(msgs.some((m) => m.content.some((c) => c.type === 'text' && (c as { text: string }).text === 'msg2')));
  assert.ok(msgs.some((m) => m.content.some((c) => c.type === 'text' && (c as { text: string }).text === 'msg3')));
});

// ---------------------------------------------------------------------------
// Engine injectSubagentMessage + restart tests
// ---------------------------------------------------------------------------

test('engine injectSubagentMessage adds to pending queue and starts loop if not running', async () => {
  const { DaedalusEngine } = await import('../../src/core/engine.ts');
  let loopStarted = false;
  const client: AiClient = {
    async *streamChat() {
      loopStarted = true;
      yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'response' }] } };
    },
  };
  const engine = new DaedalusEngine({
    client,
    cwd: process.cwd(),
    askPermission: (async () => true) as (action: string, target: string) => Promise<boolean>,
    skillDirs: [],
    maxIterations: 5,
  });
  // Inject message to a non-existent subagent (should create session and start loop)
  engine.injectSubagentMessage('test-agent', 'hello');
  // Wait for loop to start
  await sleep(50);
  assert.equal(loopStarted, true);
  await engine.dispose();
});

test('engine injectSubagentMessage does not restart loop if already running', async () => {
  const { DaedalusEngine } = await import('../../src/core/engine.ts');
  let loopCount = 0;
  const client: AiClient = {
    async *streamChat() {
      loopCount++;
      if (loopCount === 1) {
        // First loop: wait for a while to simulate running
        await sleep(100);
        yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'first' }] } };
      } else {
        // Second loop: complete immediately
        yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'second' }] } };
      }
    },
  };
  const engine = new DaedalusEngine({
    client,
    cwd: process.cwd(),
    askPermission: (async () => true) as (action: string, target: string) => Promise<boolean>,
    skillDirs: [],
    maxIterations: 5,
  });
  // Start first loop by injecting message
  engine.injectSubagentMessage('test-agent', 'first message');
  await sleep(20); // Wait for loop to start
  // Inject second message while first loop is running
  engine.injectSubagentMessage('test-agent', 'second message');
  await sleep(50); // Wait a bit
  // Should only have one loop started (the second message is queued, not restarting)
  assert.equal(loopCount, 1);
  // Wait for first loop to complete
  await sleep(150);
  // Now the second loop should have started to process the queued message
  assert.equal(loopCount, 2);
  await engine.dispose();
});
