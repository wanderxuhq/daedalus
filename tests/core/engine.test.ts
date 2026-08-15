import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DaedalusEngine } from '../../src/core/engine.ts';
import type { AiClient } from '../../src/ai/types.ts';
import { buildSystemPrompt } from '../../src/core/system-prompt.ts';
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
}> = {}) {
  return {
    client: overrides.client ?? textClient('ok'),
    cwd: process.cwd(),
    askPermission: (async () => true) as (action: string, target: string) => Promise<boolean>,
    skillDirs: overrides.skillDirs ?? [],
    maxIterations: overrides.maxIterations ?? 2,
    ...(overrides.initialState ? { initialState: overrides.initialState } : {}),
    ...(overrides.sessionStore ? { sessionStore: overrides.sessionStore } : {}),
    ...(overrides.maxContextTokens !== undefined ? { maxContextTokens: overrides.maxContextTokens } : {}),
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
        gotPrompt = params.messages.some((m) => m.role === 'system' && m.content[0].type === 'text' && m.content[0].text === buildSystemPrompt());
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
