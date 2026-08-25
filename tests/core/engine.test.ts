import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DaedalusEngine } from '../../src/core/engine.ts';
import type { AiClient, Message } from '../../src/ai/types.ts';
import type { HookConfig } from '../../src/core/hooks.ts';
import { buildSystemPrompt, DEFAULT_MAIN_AGENT_TOOLS, BUILTIN_TOOL_NAMES, DELEGATE_TOOL_NAME } from '../../src/core/system-prompt.ts';
import { SessionStore } from '../../src/core/session-store.ts';
import type { SessionState } from '../../src/core/session.ts';

function textClient(text: string): AiClient {
  return {
    async *streamChat() {
      yield { type: 'text_delta', text };
      yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text }] } };
    },
  };
}

function opts(overrides: Partial<{
  client: AiClient;
  skillDirs: string[];
  maxIterations: number;
  initialState: SessionState;
  sessionId: string;
  sessionStore: SessionStore;
  maxContextTokens: number;
  mainAgentTools: string[];
  delegateMaxDepth: number;
  hooks: HookConfig;
  enableAutoSummary: boolean;
}> = {}) {
  return {
    client: overrides.client ?? textClient('ok'),
    cwd: process.cwd(),
    askPermission: (async () => true) as (action: string, target: string) => Promise<boolean>,
    skillDirs: overrides.skillDirs ?? [],
    maxIterations: overrides.maxIterations ?? 2,
    enableAutoSummary: overrides.enableAutoSummary ?? false, // Disable by default for testing
    ...(overrides.initialState ? { initialState: overrides.initialState } : {}),
    ...(overrides.sessionStore ? { sessionStore: overrides.sessionStore } : {}),
    ...(overrides.maxContextTokens !== undefined ? { maxContextTokens: overrides.maxContextTokens } : {}),
    ...(overrides.mainAgentTools ? { mainAgentTools: overrides.mainAgentTools } : {}),
    ...(overrides.delegateMaxDepth !== undefined ? { delegateMaxDepth: overrides.delegateMaxDepth } : {}),
    ...(overrides.hooks ? { hooks: overrides.hooks } : {}),
  };
}

test('run drives a single prompt through the client', async () => {
  const engine = new DaedalusEngine(opts());
  const result = await engine.run('hello');
  assert.equal(result, 'ok');
  await engine.dispose();
});

test('session persists across runs (history accumulates)', async () => {
  let assistantCount = 0;
  const engine = new DaedalusEngine(opts({
    client: {
      async *streamChat(params) {
        assistantCount = params.messages.filter((m) => m.role === 'assistant').length;
        yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'r' }] } };
      },
    },
  }));
  await engine.run('first');
  await engine.run('second');
  assert.ok(assistantCount >= 1);
  await engine.dispose();
});

test('skills listing is exposed via getter', async () => {
  const base = join(tmpdir(), `dae-eng-${Date.now()}`);
  mkdirSync(join(base, 'review'), { recursive: true });
  writeFileSync(join(base, 'review', 'SKILL.md'), '---\nname: review\ndescription: Review\n---\nBody');
  const engine = new DaedalusEngine(opts({ skillDirs: [base] }));
  assert.equal(engine.skills[0].name, 'review');
  await engine.dispose();
  rmSync(base, { recursive: true, force: true });
});

test('loadSkill loads a skill, marks it loaded, and injects body into history', async () => {
  const base = join(tmpdir(), `dae-eng-${Date.now()}`);
  mkdirSync(join(base, 'review'), { recursive: true });
  writeFileSync(join(base, 'review', 'SKILL.md'), '---\nname: review\ndescription: Review\n---\nBody text');
  const engine = new DaedalusEngine(opts({ skillDirs: [base] }));
  const info = await engine.loadSkill('review');
  assert.equal(info.body, 'Body text');
  // A subsequent run sees the skill body as a user message in history.
  let sawBody = false;
  const probe = new DaedalusEngine(opts({
    skillDirs: [base],
    client: {
      async *streamChat(params) {
        sawBody = JSON.stringify(params.messages).includes('Body text');
        yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } };
      },
    },
  }));
  await probe.loadSkill('review');
  await probe.run('now do it');
  assert.equal(sawBody, true);
  await engine.dispose();
  await probe.dispose();
  rmSync(base, { recursive: true, force: true });
});

test('subscribe receives skill_load when loadSkill runs', async () => {
  const base = join(tmpdir(), `dae-eng-${Date.now()}`);
  mkdirSync(join(base, 'review'), { recursive: true });
  writeFileSync(join(base, 'review', 'SKILL.md'), '---\nname: review\ndescription: Review\n---\nBody');
  const engine = new DaedalusEngine(opts({ skillDirs: [base] }));
  const got: string[] = [];
  engine.subscribe((ev) => { if (ev.type === 'skill_load') got.push(ev.name); });
  await engine.loadSkill('review');
  assert.deepEqual(got, ['review']);
  await engine.dispose();
  rmSync(base, { recursive: true, force: true });
});

test('run allows the model to load a skill via the Skill tool', async () => {
  const base = join(tmpdir(), `dae-eng-${Date.now()}`);
  mkdirSync(join(base, 'review'), { recursive: true });
  writeFileSync(join(base, 'review', 'SKILL.md'), '---\nname: review\ndescription: Review\n---\nBody text');
  let iterations = 0;
  const engine = new DaedalusEngine(opts({
    skillDirs: [base],
    maxIterations: 4,
    client: {
      async *streamChat(params) {
        iterations++;
        if (iterations === 1) {
          yield { type: 'done', message: { role: 'assistant', content: [{ type: 'tool_call', id: 's1', name: 'Skill', input: { name: 'review' } }] } };
        } else {
          const hasBody = JSON.stringify(params.messages).includes('Body text');
          if (!hasBody) throw new Error('skill body not in messages after Skill tool call');
          yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'reviewed' }] } };
        }
      },
    },
  }));
  const result = await engine.run('review this');
  assert.equal(result, 'reviewed');
  assert.ok(iterations >= 2);
  await engine.dispose();
  rmSync(base, { recursive: true, force: true });
});

test('loadSkill with unknown name throws', async () => {
  const engine = new DaedalusEngine(opts());
  await assert.rejects(() => engine.loadSkill('nope'), /Unknown skill/);
  await engine.dispose();
});

test('constructor injects the system prompt once as the first message', async () => {
  let systemCount = 0;
  let firstRole = '';
  let gotPrompt = false;
  const engine = new DaedalusEngine(opts({
    client: {
      async *streamChat(params) {
        systemCount = params.messages.filter((m) => m.role === 'system').length;
        firstRole = params.messages[0]?.role ?? '';
        gotPrompt = params.messages.some((m) => m.role === 'system' && m.content[0].type === 'text' && m.content[0].text === buildSystemPrompt({ tools: [...DEFAULT_MAIN_AGENT_TOOLS] }));
        yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } };
      },
    },
  }));
  await engine.run('hi');
  assert.equal(systemCount, 1);
  assert.equal(firstRole, 'system');
  assert.equal(gotPrompt, true);
  await engine.dispose();
});

test('layering: main agent has all tools; a delegated subagent gets the full builtin toolset', async () => {
  const calls: string[][] = [];
  const client: AiClient = {
    async *streamChat(params) {
      calls.push((params.tools ?? []).map((t) => t.name));
      if (calls.length === 1) {
        // main agent delegates exploration
        yield { type: 'done', message: { role: 'assistant', content: [{ type: 'tool_call', id: 'd', name: 'delegate', input: { task: 'explore the repo' } }] } };
      } else if (calls.length === 2) {
        // subagent reports back
        yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'found it' }] } };
      } else {
        // main agent concludes
        yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } };
      }
    },
  };
  const engine = new DaedalusEngine(opts({ client, maxIterations: 5 }));
  const result = await engine.run('understand the repo');
  assert.equal(result, 'done');

  const main = calls[0];
  // Main agent has all tools: builtins + delegate + delegateMany + consult + Skill
  assert.ok(main.includes(DELEGATE_TOOL_NAME) && main.includes('read') && main.includes('write') && main.includes('edit') && main.includes('Skill'));
  assert.ok(main.includes('bash') && main.includes('ls') && main.includes('grep') && main.includes('glob'));
  // The subagent receives the FULL builtin toolset (and never delegate itself).
  assert.deepEqual(calls[1].slice().sort(), [...BUILTIN_TOOL_NAMES].slice().sort());
  await engine.dispose();
});

test('mainAgentTools can restore self-service exploration (full toolset)', async () => {
  let mainTools: string[] = [];
  const client: AiClient = {
    async *streamChat(params) {
      mainTools = (params.tools ?? []).map((t) => t.name);
      yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } };
    },
  };
  const engine = new DaedalusEngine(opts({
    client,
    mainAgentTools: [...BUILTIN_TOOL_NAMES, 'Skill', DELEGATE_TOOL_NAME],
  }));
  await engine.run('hi');
  assert.deepEqual(mainTools.slice().sort(), [...BUILTIN_TOOL_NAMES, 'Skill', DELEGATE_TOOL_NAME].slice().sort());
  await engine.dispose();
});

test('initialState restores messages verbatim (incl. system) and skills without events', async () => {
  const initialState: SessionState = {
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'VERBATIM-SYSTEM' }] },
      { role: 'user', content: [{ type: 'text', text: 'restored q' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'restored a' }] },
    ],
    loadedSkills: ['review'],
  };
  let sawSystem = '';
  const skillEvents: string[] = [];
  const engine = new DaedalusEngine(opts({
    initialState,
    client: {
      async *streamChat(params) {
        sawSystem = params.messages[0].content[0].type === 'text' ? params.messages[0].content[0].text : '';
        yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } };
      },
    },
  }));
  engine.subscribe((ev) => { if (ev.type === 'skill_load') skillEvents.push(ev.name); });
  const result = await engine.run('go');
  assert.equal(result, 'ok');
  assert.equal(sawSystem, 'VERBATIM-SYSTEM');
  assert.equal(engine.getSessionState().messages.length, 5); // system + q + a + 'go' + assistant 'ok'
  assert.deepEqual(engine.getSessionState().loadedSkills, ['review']);
  assert.deepEqual(skillEvents, []); // restore must not emit skill_load
  await engine.dispose();
});

test('initialState without a system message gets a defensive one', async () => {
  let firstRole = '';
  const engine = new DaedalusEngine(opts({
    initialState: { messages: [{ role: 'user', content: [{ type: 'text', text: 'only user' }] }], loadedSkills: [] },
    client: {
      async *streamChat(params) {
        firstRole = params.messages[0].role;
        yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } };
      },
    },
  }));
  await engine.run('x');
  assert.equal(firstRole, 'system');
  await engine.dispose();
});

test('sessionStore is saved after run and dispose', async () => {
  const dir = join(tmpdir(), `dae-eng-store-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const store = new SessionStore(dir);
  const engine = new DaedalusEngine({ ...opts(), sessionStore: store });
  await engine.run('hello store');
  let list = await store.list();
  assert.equal(list.length, 1);
  assert.ok(list[0].messageCount >= 2); // system + prompt
  await engine.dispose();
  list = await store.list();
  assert.equal(list.length, 1);
  const loaded = await store.load(list[0].id);
  assert.ok(loaded.messages.some((m) => m.content.some((c) => c.type === 'text' && c.text === 'hello store')));
  rmSync(dir, { recursive: true, force: true });
});

test('auto-save keeps a single file across runs and dispose (stable session id)', async () => {
  const dir = join(tmpdir(), `dae-eng-id-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const store = new SessionStore(dir);
  const engine = new DaedalusEngine({ ...opts(), sessionStore: store });
  await engine.run('first');
  await new Promise((r) => setTimeout(r, 1100)); // cross the id slug's second boundary
  await engine.run('second');
  await engine.dispose();
  const list = await store.list();
  assert.equal(list.length, 1); // one session = one file, regardless of timing
  const loaded = await store.load(list[0].id);
  assert.equal(loaded.messages.filter((m) => m.role === 'user' && m.content.some((c) => c.type === 'text')).length, 2);
  rmSync(dir, { recursive: true, force: true });
});

test('listSessions returns [] without a store and persisted sessions with one', async () => {
  const bare = new DaedalusEngine(opts());
  assert.deepEqual(await bare.listSessions(), []);
  await bare.dispose();

  const dir = join(tmpdir(), `dae-eng-listsess-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const store = new SessionStore(dir);
  const engine = new DaedalusEngine({ ...opts(), sessionStore: store });
  await engine.run('one');
  const list = await engine.listSessions();
  assert.equal(list.length, 1);
  assert.ok(list[0].messageCount >= 2); // system + prompt
  await engine.dispose();
  rmSync(dir, { recursive: true, force: true });
});

test('resume() throws a clear error without a session store', async () => {
  const engine = new DaedalusEngine(opts());
  await assert.rejects(() => engine.resume(), /not persisted/);
  await engine.dispose();
});

test('resume() with no saved sessions says where sessions live (actionable, not "no directory")', async () => {
  const dir = join(tmpdir(), `dae-eng-resume-empty-${Date.now()}`);
  const store = new SessionStore(dir); // dir does not exist yet
  const engine = new DaedalusEngine({ ...opts(), sessionStore: store });
  const err = await engine.resume().then(() => null, (e: Error) => e);
  assert.ok(err, 'resume must throw');
  assert.ok(!/directory/i.test(err!.message), 'must not leak a raw ENOENT');
  assert.ok(err!.message.includes('run a conversation first'), `message must be actionable, got: ${err!.message}`);
  assert.ok(err!.message.includes(dir), `message must point at the sessions dir: ${err!.message}`);
  await engine.dispose();
});

test('resume() switches to a persisted session and keeps writing to its file', async () => {
  const dir = join(tmpdir(), `dae-eng-resume-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const store = new SessionStore(dir);
  const e1 = new DaedalusEngine({ ...opts(), sessionStore: store });
  await e1.run('first session turn');
  await e1.dispose();
  const meta = (await store.latest())!;
  await new Promise((r) => setTimeout(r, 1100)); // cross the id slug's second boundary

  // A second engine has its own live session (file B); /resume switches it to A.
  const e2 = new DaedalusEngine({ ...opts(), sessionStore: store });
  await e2.run('pre-resume turn');
  assert.equal((await store.list()).length, 2);

  const resumed = await e2.resume(meta.id);
  assert.equal(resumed.id, meta.id);
  await e2.run('resumed turn');
  await e2.dispose();

  const list = await store.list();
  assert.equal(list.length, 2); // still A + B — no third file
  const a = await store.load(meta.id);
  assert.ok(a.messages.some((m) => m.content.some((c) => c.type === 'text' && c.text === 'resumed turn')));
  // The pre-resume session was persisted before the switch — nothing was lost.
  const b = await store.load(list.find((s) => s.id !== meta.id)!.id);
  assert.ok(b.messages.some((m) => m.content.some((c) => c.type === 'text' && c.text === 'pre-resume turn')));
  rmSync(dir, { recursive: true, force: true });
});

test('resume() without an id uses the most recent session', async () => {
  const dir = join(tmpdir(), `dae-eng-resumelatest-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const store = new SessionStore(dir);
  const e1 = new DaedalusEngine({ ...opts(), sessionStore: store });
  await e1.run('first session');
  await e1.dispose();
  await new Promise((r) => setTimeout(r, 1100)); // cross the id slug's second boundary

  const e2 = new DaedalusEngine({ ...opts(), sessionStore: store });
  await e2.run('latest session');
  await e2.dispose();
  const latestMeta = (await store.latest())!;

  const e3 = new DaedalusEngine({ ...opts(), sessionStore: store });
  const resumed = await e3.resume(); // no id → latest (e2's session)
  assert.equal(resumed.id, latestMeta.id);
  await e3.run('continued');
  await e3.dispose();
  const loaded = await store.load(latestMeta.id);
  assert.ok(loaded.messages.some((m) => m.content.some((c) => c.type === 'text' && c.text === 'continued')));
  rmSync(dir, { recursive: true, force: true });
});

test('resume (initialState + sessionId) continues writing to the same file', async () => {
  const dir = join(tmpdir(), `dae-eng-res-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const store = new SessionStore(dir);
  const e1 = new DaedalusEngine({ ...opts(), sessionStore: store });
  await e1.run('first turn');
  await e1.dispose();
  const meta = await store.latest()!;
  const loaded = await store.load(meta.id);
  const e2 = new DaedalusEngine({ ...opts(), sessionStore: store, initialState: { messages: loaded.messages, loadedSkills: loaded.loadedSkills }, sessionId: loaded.id });
  await e2.run('second turn');
  await e2.dispose();
  const list = await store.list();
  assert.equal(list.length, 1); // resumed engine updates the ORIGINAL file, no new file
  const after = await store.load(meta.id);
  assert.ok(after.messages.some((m) => m.content.some((c) => c.type === 'text' && c.text === 'second turn')));
  rmSync(dir, { recursive: true, force: true });
});

test('usage() accumulates tokens across runs from usage events', async () => {
  const engine = new DaedalusEngine(opts({
    client: {
      async *streamChat() {
        yield { type: 'usage', inputTokens: 100, outputTokens: 40 };
        yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'r1' }] } };
      },
    },
  }));
  await engine.run('first');
  await engine.run('second');
  assert.deepEqual(engine.usage(), { inputTokens: 200, outputTokens: 80 });
  await engine.dispose();
});

test('run forwards an AbortSignal to the client', async () => {
  const ac = new AbortController();
  let gotSignal: AbortSignal | undefined;
  const engine = new DaedalusEngine(opts({
    client: {
      async *streamChat(params) {
        gotSignal = params.signal;
        yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } };
      },
    },
  }));
  await engine.run('hi', { signal: ac.signal });
  assert.ok(gotSignal === ac.signal);
  await engine.dispose();
});

test('setModel forwards a per-request model override; unset uses the client default', async () => {
  const seen: (string | undefined)[] = [];
  const client: AiClient = {
    async *streamChat(params) {
      seen.push(params.model);
      yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } };
    },
  };
  const engine = new DaedalusEngine(opts({ client }));
  assert.equal(engine.getModel(), undefined);
  await engine.run('default');
  engine.setModel('claude-test');
  assert.equal(engine.getModel(), 'claude-test');
  await engine.run('overridden');
  assert.deepEqual(seen, [undefined, 'claude-test']);
  await engine.dispose();
});

test('clearConversation drops history but keeps the system prompt and skills', async () => {
  const engine = new DaedalusEngine(opts({
    initialState: {
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'SYS' }] },
        { role: 'user', content: [{ type: 'text', text: 'q1' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
      ],
      loadedSkills: ['review'],
    },
  }));
  assert.equal(engine.getSessionState().messages.length, 3);
  const dropped = engine.clearConversation();
  assert.equal(dropped, 2);
  const after = engine.getSessionState();
  assert.deepEqual(after.messages.map((m) => m.role), ['system']);
  assert.deepEqual(after.loadedSkills, []);
  await engine.dispose();
});

test('contextUsage estimates the live history tokens vs the budget', async () => {
  const engine = new DaedalusEngine(opts({ maxContextTokens: 500 }));
  const u = engine.contextUsage();
  assert.equal(u.maxTokens, 500);
  assert.ok(u.tokens > 0, 'system prompt alone is > 0 tokens');
  await engine.dispose();
});

test('compactNow summarizes when over budget and emits context_compact', async () => {
  const messages: Message[] = [];
  for (let i = 0; i < 8; i++) {
    messages.push({ role: 'user', content: [{ type: 'text', text: 'question '.repeat(300) }] });
    messages.push({ role: 'assistant', content: [{ type: 'text', text: 'answer '.repeat(300) }] });
  }
  const events: string[] = [];
  const engine = new DaedalusEngine(opts({
    maxContextTokens: 500, // way under the ~10k of history above
    initialState: { messages, loadedSkills: [] },
    client: textClient('summarized'),
  }));
  engine.subscribe((ev) => { if (ev.type === 'context_compact' || ev.type === 'context_trim') events.push(ev.type); });
  const res = await engine.compactNow();
  assert.equal(res.status, 'compacted');
  assert.ok(res.dropped > 0);
  assert.ok(res.kept < messages.length + 1); // + defensive system prompt
  assert.deepEqual(events, ['context_compact']);
  await engine.dispose();
});

test('compactNow reports idle when under budget', async () => {
  const engine = new DaedalusEngine(opts());
  const res = await engine.compactNow();
  assert.deepEqual(res, { status: 'idle', dropped: 0, kept: 1 }); // just the system prompt
  await engine.dispose();
});

test('initMemory creates DAEDALUS.md only when missing', async () => {
  const dir = join(tmpdir(), `dae-eng-init-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const engine = new DaedalusEngine({ ...opts(), cwd: dir });
  const first = await engine.initMemory();
  assert.equal(first.created, true);
  assert.equal(first.path, join(dir, 'DAEDALUS.md'));
  assert.ok(readFileSync(join(dir, 'DAEDALUS.md'), 'utf8').includes('# DAEDALUS.md'));
  const second = await engine.initMemory();
  assert.equal(second.created, false); // never overwrites
  await engine.dispose();
  rmSync(dir, { recursive: true, force: true });
});

test('dispose runs the stop hook', async () => {
  const dir = join(tmpdir(), `dae-eng-stop-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const marker = join(dir, 'stopped.txt');
  const engine = new DaedalusEngine(opts({
    hooks: { stop: `node -e "require('fs').writeFileSync(process.argv[1], 'bye')" ${JSON.stringify(marker)}` },
  }));
  await engine.dispose();
  assert.equal(readFileSync(marker, 'utf8'), 'bye');
  rmSync(dir, { recursive: true, force: true });
});

test('plan mode removes write/edit from the main toolset and exits after a run', async () => {
  let toolNames: string[] = [];
  const client: AiClient = {
    async *streamChat(params) {
      toolNames = (params.tools ?? []).map((t) => t.name);
      yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'plan' }] } };
    },
  };
  const engine = new DaedalusEngine(opts({ client }));
  assert.equal(engine.getPlanMode(), false);
  engine.setPlanMode(true);
  assert.equal(engine.getPlanMode(), true);

  await engine.run('explore read-only');
  assert.ok(!toolNames.includes('write'), 'write must be absent in plan mode');
  assert.ok(!toolNames.includes('edit'), 'edit must be absent in plan mode');
  assert.ok(toolNames.includes('read'), 'read stays available');
  assert.equal(engine.getPlanMode(), false, 'a completed run exits plan mode');

  // Normal mode has write/edit back on the next run.
  await engine.run('now implement');
  assert.ok(toolNames.includes('write'));
  assert.ok(toolNames.includes('edit'));
  await engine.dispose();
});

test('inspecting an unknown subagent does not materialize an empty pooled session', async () => {
  const engine = new DaedalusEngine(opts());
  assert.deepEqual(engine.listSubagents(), []);
  // The REPL /agent <name> path: must return [] without creating a session
  // (which would then show up in /agents and emit a phantom session_start).
  assert.deepEqual(engine.getSubagentMessages('never-used'), []);
  assert.deepEqual(engine.listSubagents(), [], 'no session created by inspection');
  await engine.dispose();
});

test('injectSubagentMessage adds a user message to a running subagent session', async () => {
  const engine = new DaedalusEngine(opts());
  // Simulate a delegate-created subagent by injecting into a named session.
  // First, ensure the session exists.
  engine.injectSubagentMessage('worker', 'do the thing');
  const msgs = engine.getSubagentMessages('worker');
  // The injected message should be present (role: user).
  const userMsg = msgs.find((m) => m.role === 'user');
  assert.ok(userMsg, 'user message was injected');
  assert.equal(userMsg.content[0].type, 'text');
  assert.equal((userMsg.content[0] as any).text, 'do the thing');
  await engine.dispose();
});

test('injectSubagentMessage on unknown name creates the session', async () => {
  const engine = new DaedalusEngine(opts());
  assert.deepEqual(engine.listSubagents(), []);
  engine.injectSubagentMessage('new-agent', 'hello');
  // Wait for the agent loop to complete
  await new Promise((r) => setTimeout(r, 100));
  const list = engine.listSubagents();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'new-agent');
  // 3 messages: system prompt + user message + assistant response
  assert.equal(list[0].messageCount, 3);
  await engine.dispose();
});

undefined
