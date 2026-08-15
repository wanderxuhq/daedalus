# Session Resume + Context Trimming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist Daedalus sessions to disk with `--resume` recovery, and bound the message history with a cache-aware, turn-boundary-respecting token trimmer that never drops skill bodies.

**Architecture:** Add two pure core modules — `src/agent/context.ts` (token estimation + `trimHistory`) and `src/core/session-store.ts` (`SessionStore`, JSON files under `~/.daedalus/sessions`). `Session` gains `getState`/`replaceMessages`/`restoreLoadedSkills`; `DaedalusEngine` gains `initialState` seeding, auto-save after each `run()`/`dispose()`, and a `maxContextTokens` budget. `runAgent` trims history before each iteration and emits a new `context_trim` CoreEvent. The CLI adds `--resume [id]`. Skill bodies are protected by a content marker (`[Skill: name]`) rather than object identity, because the Skill-tool path builds the `tool_result` message inside the loop where no caller holds the object.

**Tech Stack:** TypeScript (Node 24 native type-stripping), zero runtime dependencies (only `node:fs`/`node:fs/promises`/`node:os`/`node:path` added), `node:test` for testing.

**Spec:** `docs/superpowers/specs/2026-08-10-session-resume-context-design.md` — this plan argues from that design; executors read both.

## Global Constraints

- **No node-gyp:** never add any dependency that directly or indirectly requires node-gyp. Any `npm install` must be approved by the user first. This plan adds **zero new dependencies**.
- **Prompt-caching maximization:** the system-prompt prefix must stay stable; trimming is rare-trigger (only when over budget) and big-step (to 50% of budget), and restored sessions reuse the persisted system message verbatim (never re-`buildSystemPrompt()` mid-session). `cache: { enabled: true }` stays on `streamChat`.
- **Core does not depend on CLI/UI.** `SessionStore` and trimming live in core; `src/cli/` imports core only.
- **TypeScript conventions:** `erasableSyntaxOnly: true` — no enums, no namespaces, no constructor parameter properties. Imports use explicit `.ts` extensions. `target: ES2022` — no ES2023+ methods (no `findLast`, no `toSorted`).
- **Testing:** `node --test 'tests/**/*.test.ts'`. All existing tests (98) must keep passing; only mechanical `dispose()` → `await dispose()` edits are allowed in existing tests.
- **Turn boundary:** a user "prompt" message is `role === 'user'` with content that is NOT all `tool_result` blocks. A turn = that prompt + every message after it up to (not including) the next prompt. Trimming only ever drops whole turns, never splitting an assistant `tool_call` from its `tool_result`.
- **`MIN_KEEP_TURNS = 2`:** trimming never drops below two turns even when every remaining turn is over budget (budget is advisory).

---

## File Structure

**New files:**
- `src/agent/context.ts` — `estimateTokens`, `trimHistory`, `TrimOptions`, `MIN_KEEP_TURNS`
- `src/core/session-store.ts` — `SessionStore`, `SessionMeta`, `StoredSession`
- `tests/agent/context.test.ts`
- `tests/core/session-store.test.ts`

**Modified files:**
- `src/core/session.ts` — `SessionState` interface + `getState`/`replaceMessages`/`restoreLoadedSkills`
- `src/core/skills/skill-tool.ts` — return `[Skill: ${name}]\n\n${body}` (protection marker)
- `src/core/events.ts` — add `context_trim` to `CoreEvent`
- `src/core/engine.ts` — `initialState`/`sessionStore`/`maxContextTokens`/`getSessionState`/auto-save; `dispose()` becomes async
- `src/agent/loop.ts` — `maxContextTokens` param; trim before each iteration; emit `context_trim`
- `src/cli/render.ts` — render `context_trim`
- `src/config/config.ts` — `maxContextTokens` config + `DAEDALUS_MAX_CONTEXT_TOKENS` env
- `src/cli/main.ts` — `--resume [id]`; pass `sessionStore` + `maxContextTokens`; `await engine.dispose()`
- `src/core/index.ts`, `src/index.ts` — export new types/functions
- `README.md` — document resume + trimming

**Extended test files:**
- `tests/core/session.test.ts`
- `tests/core/skills/skill-tool.test.ts`
- `tests/core/engine.test.ts`
- `tests/agent/loop.test.ts`
- `tests/config/config.test.ts`

> **Ordering note vs. design §7:** the design listed `SessionStore` (B) before `Session` state methods (C). This plan swaps them (B = Session state, C = SessionStore) so `SessionStore` can import the already-defined `SessionState` type cleanly. Task D adds the skill-tool marker (design put it inside C). Everything else matches.

---

## Task A: Context trimming pure functions

**Files:**
- Create: `src/agent/context.ts`
- Test: `tests/agent/context.test.ts`

**Interfaces:**
- Consumes: `Message` from `../ai/types.ts`
- Produces (used by Task F loop integration and Task E engine budget):
  ```ts
  export const MIN_KEEP_TURNS = 2;
  export function estimateTokens(messages: Message[]): number;
  export interface TrimOptions {
    maxTokens: number;
    estimate?: typeof estimateTokens;
    isProtected?: (m: Message) => boolean;
  }
  export function trimHistory(messages: Message[], opts: TrimOptions): Message[];
  ```
  `trimHistory` returns the **same array reference** when nothing is trimmed (callers check `!==`).

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/agent/context.test.ts`
Expected: FAIL — "Cannot find module '/root/projects/daedalus/src/agent/context.ts'"

- [ ] **Step 3: Write the implementation**

```ts
import type { Message } from '../ai/types.ts';

/** Minimum number of conversation turns that trimming always keeps. */
export const MIN_KEEP_TURNS = 2;

/**
 * Zero-dependency token estimate: 4 per message + 2 per content block + 1 token
 * per 4 chars of the block's text. Deliberately approximate and slightly
 * conservative — the goal is to avoid blowing the window, not exactness.
 */
export function estimateTokens(messages: Message[]): number {
  let n = 0;
  for (const m of messages) {
    n += 4;
    for (const b of m.content) {
      const text = b.type === 'text' ? b.text
        : b.type === 'thinking' ? b.thinking
        : b.type === 'tool_result' ? b.content
        : b.type === 'tool_call' ? JSON.stringify(b.input) ?? '' : '';
      n += Math.ceil(text.length / 4);
      n += 2;
    }
  }
  return n;
}

export interface TrimOptions {
  /** History budget in estimated tokens. */
  maxTokens: number;
  /** Injectable estimator (tests use a message-count function). */
  estimate?: typeof estimateTokens;
  /** A message the trimmer must never drop. Default: skill-body messages. */
  isProtected?: (m: Message) => boolean;
}

/**
 * A user "prompt" message: role user whose content is not entirely tool_result
 * blocks (tool results are themselves user-role and must not start a turn).
 */
function isPrompt(m: Message): boolean {
  return m.role === 'user' && m.content.some((c) => c.type !== 'tool_result');
}

/** Skill bodies arrive as `[Skill: <name>]\n\n<body>` in text (engine path) or
 *  tool_result content (Skill-tool path). Either form must never be trimmed while
 *  `loadedSkills` still marks it loaded. */
function isSkillBody(m: Message): boolean {
  return m.content.some((b) =>
    (b.type === 'text' && b.text.startsWith('[Skill: ')) ||
    (b.type === 'tool_result' && b.content.startsWith('[Skill: ')),
  );
}

/**
 * Drop oldest whole turns until the history fits `maxTokens` (or `MIN_KEEP_TURNS`
 * turns remain), keeping the system prefix and never dropping a protected message
 * (pulling the cut back to keep its whole turn). Returns the input array unchanged
 * when nothing is trimmed, so callers can detect a trim via `!==`.
 */
export function trimHistory(messages: Message[], opts: TrimOptions): Message[] {
  const estimate = opts.estimate ?? estimateTokens;
  const isProtected = opts.isProtected ?? isSkillBody;

  // Leading system messages are never trimmed.
  let start = 0;
  while (start < messages.length && messages[start].role === 'system') start++;
  const prefix = messages.slice(0, start);
  const conversation = messages.slice(start);
  if (conversation.length === 0) return messages;

  // Turn-boundary indices into `conversation` (start of each user prompt).
  const bounds: number[] = [];
  for (let i = 0; i < conversation.length; i++) {
    if (isPrompt(conversation[i])) bounds.push(i);
  }
  if (bounds.length === 0) return messages;

  // How many leading turns to drop (grows until within budget / at the floor).
  let cut = 0;
  while (
    cut < bounds.length - MIN_KEEP_TURNS &&
    estimate([...prefix, ...conversation.slice(bounds[cut])]) > opts.maxTokens
  ) {
    cut++;
  }

  // Pull the cut back before the earliest protected turn inside the dropped region.
  let protectIdx = -1;
  for (let k = 0; k < cut; k++) {
    const turnEnd = bounds[k + 1] ?? conversation.length;
    for (let j = bounds[k]; j < turnEnd; j++) {
      if (isProtected(conversation[j])) { protectIdx = k; break; }
    }
    if (protectIdx >= 0) break;
  }
  if (protectIdx >= 0) cut = protectIdx;

  if (cut === 0) return messages;
  return [...prefix, ...conversation.slice(bounds[cut])];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/agent/context.test.ts`
Expected: PASS (all 9 tests)

- [ ] **Step 5: Commit**

```bash
git add src/agent/context.ts tests/agent/context.test.ts
git commit -m "feat: add token estimation and cache-aware history trimming"
```

---

## Task B: Session state methods

**Files:**
- Modify: `src/core/session.ts`
- Test: `tests/core/session.test.ts`

**Interfaces:**
- Consumes: `Message` from `../ai/types.ts`
- Produces (used by Task C `SessionStore`, Task E engine, Task G CLI):
  ```ts
  export interface SessionState {
    messages: Message[];
    loadedSkills: string[];
  }
  // new Session methods:
  getState(): SessionState;                    // deep copy of messages + skills
  replaceMessages(msgs: Message[]): void;      // wholesale history swap
  restoreLoadedSkills(names: string[]): void;  // sets the set, no skill_load event
  ```

- [ ] **Step 1: Write the failing test (append to `tests/core/session.test.ts`)**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/core/session.test.ts`
Expected: FAIL — `s.getState is not a function`

- [ ] **Step 3: Write the implementation**

Add to `src/core/session.ts` (after the imports):

```ts
/** Serializable snapshot of a session — what SessionStore persists and resume seeds from. */
export interface SessionState {
  messages: Message[];
  loadedSkills: string[];
}
```

Add the three methods inside the `Session` class:

```ts
  /** Deep copy of messages + skills so callers cannot mutate internal state. */
  getState(): SessionState {
    return {
      messages: this.msgs.map((m) => ({
        role: m.role,
        content: m.content.map((b) => ({ ...b })),
      })),
      loadedSkills: [...this.skills],
    };
  }

  /** Wholesale history swap (trimming / restore). Callers pass fresh arrays. */
  replaceMessages(msgs: Message[]): void {
    this.msgs = msgs;
  }

  /** Restore the loaded-skill set without emitting skill_load events. */
  restoreLoadedSkills(names: string[]): void {
    this.skills = new Set(names);
  }
```

> Note: `{ ...b }` copies each content block; `tool_call.input` and `tool_result.content` are treated as immutable (nothing mutates them), so the copy is sufficient for array-level isolation.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/core/session.test.ts`
Expected: PASS (6 tests — 3 existing + 3 new)

- [ ] **Step 5: Commit**

```bash
git add src/core/session.ts tests/core/session.test.ts
git commit -m "feat: add session state snapshot, restore, and history replacement"
```

---

## Task C: SessionStore

**Files:**
- Create: `src/core/session-store.ts`
- Test: `tests/core/session-store.test.ts`

**Interfaces:**
- Consumes: `Message` from `../ai/types.ts`, `SessionState` from `./session.ts`, `node:fs/promises`, `node:os`, `node:path`
- Produces (used by Task E engine, Task G CLI):
  ```ts
  export interface SessionMeta { id: string; updatedAt: string; messageCount: number; }
  export interface StoredSession extends SessionState {
    id: string; createdAt: string; updatedAt: string; cwd?: string;
  }
  export class SessionStore {
    constructor(dir?: string);                          // default ~/.daedalus/sessions (DAEDALUS_SESSIONS_DIR overrides)
    save(state: SessionState, meta?: { id?: string; cwd?: string }): Promise<string>;
    load(id: string): Promise<StoredSession>;
    list(): Promise<SessionMeta[]>;                     // sorted by updatedAt desc; no full messages
    latest(): Promise<SessionMeta | null>;
    remove(id: string): Promise<void>;
  }
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../../src/core/session-store.ts';
import type { SessionState } from '../../src/core/session.ts';

const state: SessionState = {
  messages: [
    { role: 'system', content: [{ type: 'text', text: 'sys' }] },
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
  ],
  loadedSkills: ['review'],
};

function tmpStore(): { store: SessionStore; dir: string } {
  const dir = join(tmpdir(), `dae-store-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return { store: new SessionStore(dir), dir };
}

test('save writes a JSON file and load round-trips state', async () => {
  const { store, dir } = tmpStore();
  const id = await store.save(state);
  assert.ok(id.length > 0);
  assert.ok(existsSync(join(dir, `${id}.json`)));
  const loaded = await store.load(id);
  assert.deepEqual(loaded.messages, state.messages);
  assert.deepEqual(loaded.loadedSkills, state.loadedSkills);
  assert.equal(loaded.id, id);
  assert.ok(loaded.createdAt);
  assert.ok(loaded.updatedAt);
  rmSync(dir, { recursive: true, force: true });
});

test('save reuses a provided id and preserves createdAt across updates', async () => {
  const { store } = tmpStore();
  await store.save(state, { id: 'fixed' });
  const first = await store.load('fixed');
  await new Promise((r) => setTimeout(r, 5));
  const second = await store.save({
    messages: [...state.messages, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }],
    loadedSkills: ['review'],
  }, { id: 'fixed' });
  assert.equal(second, 'fixed');
  const loaded = await store.load('fixed');
  assert.equal(loaded.createdAt, first.createdAt);
  assert.ok(loaded.updatedAt >= first.updatedAt);
  assert.equal(loaded.messages.length, 3);
});

test('list returns metadata sorted by updatedAt desc, without full messages', async () => {
  const { store } = tmpStore();
  await store.save(state, { id: 'older' });
  await new Promise((r) => setTimeout(r, 5));
  await store.save(state, { id: 'newer' });
  const list = await store.list();
  assert.equal(list.length, 2);
  assert.equal(list[0].id, 'newer');
  assert.equal(list[1].id, 'older');
  assert.equal(list[0].messageCount, 2);
  assert.ok(!('messages' in list[0]));
});

test('latest returns the most recently updated session', async () => {
  const { store } = tmpStore();
  await store.save(state, { id: 'a' });
  await new Promise((r) => setTimeout(r, 5));
  await store.save(state, { id: 'b' });
  const latest = await store.latest();
  assert.equal(latest!.id, 'b');
});

test('remove deletes the file', async () => {
  const { store, dir } = tmpStore();
  await store.save(state, { id: 'gone' });
  await store.remove('gone');
  assert.ok(!existsSync(join(dir, 'gone.json')));
});

test('a leftover .tmp file is ignored and does not corrupt the store', async () => {
  const { store, dir } = tmpStore();
  await store.save(state, { id: 'real' });
  writeFileSync(join(dir, 'real.json.tmp'), 'not valid json');
  const list = await store.list();
  assert.equal(list.length, 1);
  const loaded = await store.load('real');
  assert.equal(loaded.messages.length, 2);
});

test('load throws on corrupt JSON and on a missing id', async () => {
  const { store, dir } = tmpStore();
  writeFileSync(join(dir, 'corrupt.json'), '{nope');
  await assert.rejects(() => store.load('corrupt'), /Corrupt/);
  await assert.rejects(() => store.load('missing'), /not found/);
});

test('load throws when the file has no messages or loadedSkills arrays', async () => {
  const { store, dir } = tmpStore();
  writeFileSync(join(dir, 'shape.json'), JSON.stringify({ id: 'shape' }));
  await assert.rejects(() => store.load('shape'), /Corrupt/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/core/session-store.test.ts`
Expected: FAIL — "Cannot find module '/root/projects/daedalus/src/core/session-store.ts'"

- [ ] **Step 3: Write the implementation**

```ts
import { mkdir, readdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SessionState } from './session.ts';

export interface SessionMeta {
  id: string;
  updatedAt: string;
  messageCount: number;
}

export interface StoredSession extends SessionState {
  id: string;
  createdAt: string;
  updatedAt: string;
  cwd?: string;
}

function defaultDir(): string {
  return process.env.DAEDALUS_SESSIONS_DIR ?? join(homedir(), '.daedalus', 'sessions');
}

/** Local-time slug id: `2026-08-09T23-15-07` (sortable, unique enough). */
function makeId(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}T${p(now.getHours())}-${p(now.getMinutes())}-${p(now.getSeconds())}`;
}

/** File-backed session storage: one JSON file per session in `~/.daedalus/sessions`. */
export class SessionStore {
  private dir: string;

  constructor(dir?: string) {
    this.dir = dir ?? defaultDir();
  }

  private file(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  /** Persist a session state; returns the session id. Atomic: tmp file + rename. */
  async save(state: SessionState, meta: { id?: string; cwd?: string } = {}): Promise<string> {
    await mkdir(this.dir, { recursive: true });
    const id = meta.id ?? makeId();
    let existing: StoredSession | null = null;
    try {
      existing = JSON.parse(await readFile(this.file(id), 'utf8')) as StoredSession;
    } catch {
      // New session (or unreadable previous file — overwrite with a fresh record).
    }
    const now = new Date().toISOString();
    const payload: StoredSession = {
      id,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      cwd: meta.cwd ?? existing?.cwd,
      messages: state.messages,
      loadedSkills: state.loadedSkills,
    };
    const tmp = this.file(`${id}.tmp`);
    await writeFile(tmp, JSON.stringify(payload, null, 2));
    await rename(tmp, this.file(id));
    return id;
  }

  /** Load a session; throws a clear Error on a missing or corrupt file. */
  async load(id: string): Promise<StoredSession> {
    let raw: string;
    try {
      raw = await readFile(this.file(id), 'utf8');
    } catch {
      throw new Error(`Session not found: ${id}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Corrupt session file: ${this.file(id)}`);
    }
    const p = parsed as Partial<StoredSession>;
    if (!p || !Array.isArray(p.messages) || !Array.isArray(p.loadedSkills)) {
      throw new Error(`Corrupt session file: ${this.file(id)}`);
    }
    return p as StoredSession;
  }

  /** List session metadata (newest first) without reading full message bodies. */
  async list(): Promise<SessionMeta[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const metas: SessionMeta[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -'.json'.length);
      try {
        const p = JSON.parse(await readFile(this.file(id), 'utf8')) as Partial<StoredSession>;
        metas.push({
          id,
          updatedAt: p.updatedAt ?? '',
          messageCount: Array.isArray(p.messages) ? p.messages.length : 0,
        });
      } catch {
        // Skip unreadable/corrupt files; they surface only on explicit load().
      }
    }
    metas.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    return metas;
  }

  async latest(): Promise<SessionMeta | null> {
    const metas = await this.list();
    return metas[0] ?? null;
  }

  async remove(id: string): Promise<void> {
    await rm(this.file(id), { force: true });
  }
}
```

> Note: `SessionState` is the only type import — `Message` is intentionally NOT imported (unused).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/core/session-store.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add src/core/session-store.ts tests/core/session-store.test.ts
git commit -m "feat: add file-backed SessionStore with atomic writes"
```

---

## Task D: Skill-tool protection marker

**Files:**
- Modify: `src/core/skills/skill-tool.ts`
- Test: `tests/core/skills/skill-tool.test.ts`

**Interfaces:**
- Consumes: existing `createSkillTool(registry, session)` signature
- Produces: the Skill tool's `execute` now returns `[Skill: ${name}]\n\n${skill.body}` as its tool_result content — matching the engine `loadSkill()` injection format so `trimHistory`'s default `isProtected` recognizes both paths.

- [ ] **Step 1: Write the failing test (append to `tests/core/skills/skill-tool.test.ts`)**

```ts
test('Skill tool returns the body prefixed with the [Skill: name] marker', async () => {
  const session = new Session();
  const tool = createSkillTool(regWith(['review']), session);
  const res = await tool.execute({ name: 'review' }, ctx());
  assert.ok(String(res.content).startsWith('[Skill: review]'));
  assert.ok(String(res.content).includes('Body of review'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/core/skills/skill-tool.test.ts`
Expected: FAIL — the new assertion `startsWith('[Skill: review]')` fails (content is bare body)

- [ ] **Step 3: Write the minimal change**

In `src/core/skills/skill-tool.ts`, change the success return:

```ts
      session.markSkillLoaded(name);
      return { content: `[Skill: ${name}]\n\n${skill.body}` };
```

(The existing `loadSkill` engine path already injects `[Skill: ${name}]\n\n${skill.body}` — this unifies the two paths.)

- [ ] **Step 4: Run the full skill-tool + cache-stability + engine tests**

Run: `node --test tests/core/skills/skill-tool.test.ts tests/core/cache-stability.test.ts tests/core/engine.test.ts`
Expected: PASS — existing assertions use `includes('Body of review')` / `includes('Body text')`, unaffected by the prefix

- [ ] **Step 5: Commit**

```bash
git add src/core/skills/skill-tool.ts tests/core/skills/skill-tool.test.ts
git commit -m "feat: tag Skill tool results with [Skill: name] marker for trim protection"
```

---

## Task E: Engine — restore, auto-save, budget

**Files:**
- Modify: `src/core/events.ts`
- Modify: `src/core/engine.ts`
- Test: `tests/core/engine.test.ts`

**Interfaces:**
- Consumes: `SessionState` (Task B), `SessionStore` (Task C), `runAgent` with `maxContextTokens` (Task F — added next, but engine passes the option now; `runAgent` ignores unknown fields until Task F lands, so keep this task's engine change self-contained by adding `maxContextTokens` to `RunAgentParams` here as an accepted-but-unused field? **No** — do not forward-pass a field the callee ignores. Instead, add the engine field and wire it into the `runAgent` call; Task F adds the `RunAgentParams.maxContextTokens` field. The engine's `run()` change in this task references the field via a normal object literal; TypeScript-wise it will only typecheck once Task F lands — acceptable since `node --test` runs type-stripped and the field is additive.)
- Produces (used by Task G CLI):
  ```ts
  export const DEFAULT_MAX_CONTEXT_TOKENS = 100_000;
  export interface EngineOptions {
    client: AiClient; cwd: string;
    askPermission?: (action: string, target: string) => Promise<boolean>;
    skillDirs?: string[]; maxIterations?: number;
    initialState?: SessionState;
    sessionStore?: SessionStore;
    maxContextTokens?: number;
  }
  // new/changed on DaedalusEngine:
  getSessionState(): SessionState;
  run(prompt: string): Promise<string>;   // persists after runAgent completes
  dispose(): Promise<void>;               // persists then emits session_end (was sync)
  ```
  `CoreEvent` gains: `| { type: 'context_trim'; dropped: number; kept: number }`

- [ ] **Step 1: Add `context_trim` to the event union**

In `src/core/events.ts`, add to the `CoreEvent` union:

```ts
  | { type: 'context_trim'; dropped: number; kept: number }
```

- [ ] **Step 2: Write the failing tests (append to `tests/core/engine.test.ts`)**

First extend the `opts()` helper's override type so the new options can be passed:

```ts
function opts(overrides: Partial<{
  client: AiClient;
  skillDirs: string[];
  maxIterations: number;
  initialState: SessionState;
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
```

Add imports for the new types at the top of the test file:

```ts
import { SessionStore } from '../../src/core/session-store.ts';
import type { SessionState } from '../../src/core/session.ts';
```

Append the new tests:

```ts
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
```

- [ ] **Step 3: Update the existing `dispose()` calls to await**

`dispose()` becomes async. Update every call site in the test suite mechanically. The regex is anchored to the start of the line (optional leading whitespace) so lines already written as `await engine.dispose();` are left untouched (no double `await`):

```bash
grep -rl '\.dispose();' tests/ | xargs sed -i -E 's/^([[:space:]]*)engine\.dispose\(\);/\1await engine.dispose();/; s/^([[:space:]]*)probe\.dispose\(\);/\1await probe.dispose();/'
```

Note: `Session.dispose()` stays synchronous — only `DaedalusEngine.dispose()` becomes async, so `s.dispose();` calls in `tests/core/session.test.ts` must remain unchanged (and this regex does not touch them).

Run: `node --test tests/core/engine.test.ts tests/core/cache-stability.test.ts`
Expected: still PASS — the `await` is on a no-op persist (no `sessionStore` passed), so behavior is identical.

- [ ] **Step 4: Write the implementation**

Rewrite `src/core/engine.ts` to:

```ts
import type { AiClient } from '../ai/types.ts';
import type { Tool } from '../tools/types.ts';
import { tools as builtinTools } from '../tools/registry.ts';
import type { CoreEvent } from './events.ts';
import { Session } from './session.ts';
import type { SessionState } from './session.ts';
import { SkillRegistry } from './skills/registry.ts';
import type { SkillInfo } from './skills/types.ts';
import { createSkillTool } from './skills/skill-tool.ts';
import type { SessionStore } from './session-store.ts';
import { runAgent } from '../agent/loop.ts';
import { buildSystemPrompt } from './system-prompt.ts';

export const DEFAULT_MAX_CONTEXT_TOKENS = 100_000;

export interface EngineOptions {
  client: AiClient;
  cwd: string;
  /** Optional; the REPL installs its own via {@link setAskPermission}. Defaults to deny. */
  askPermission?: (action: string, target: string) => Promise<boolean>;
  skillDirs?: string[];
  maxIterations?: number;
  /** Seed the session from a persisted state (skips building a new system message). */
  initialState?: SessionState;
  /** When set, the engine persists the session after every run() and dispose(). */
  sessionStore?: SessionStore;
  /** History budget in estimated tokens. Default {@link DEFAULT_MAX_CONTEXT_TOKENS}. */
  maxContextTokens?: number;
}

export class DaedalusEngine {
  private session: Session;
  private registry: SkillRegistry;
  private tools: Tool[];
  private client: AiClient;
  private cwd: string;
  private askPermission: (action: string, target: string) => Promise<boolean>;
  private maxIterations?: number;
  private sessionStore?: SessionStore;
  private maxContextTokens: number;

  constructor(opts: EngineOptions) {
    this.session = new Session();
    this.session.start();
    this.registry = new SkillRegistry(opts.skillDirs);
    this.client = opts.client;
    this.cwd = opts.cwd;
    this.askPermission = opts.askPermission ?? (async () => false);
    this.maxIterations = opts.maxIterations;
    this.sessionStore = opts.sessionStore;
    this.maxContextTokens = opts.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS;
    if (opts.initialState) {
      // Restore verbatim: the persisted system message is reused as-is so the cache
      // prefix stays byte-identical across a resume (design §3.2). Defensive re-add
      // only when the restored history lacks a system message (old/corrupt state) —
      // PREPENDED so system stays at index 0 (the codebase-wide invariant and what
      // the Step 2 test asserts; §3.3 ruling by controller).
      this.session.replaceMessages(opts.initialState.messages);
      this.session.restoreLoadedSkills(opts.initialState.loadedSkills);
      if (!opts.initialState.messages.some((m) => m.role === 'system')) {
        this.session.replaceMessages([
          { role: 'system', content: [{ type: 'text', text: buildSystemPrompt() }] },
          ...opts.initialState.messages,
        ]);
      }
    } else {
      this.session.addMessage({ role: 'system', content: [{ type: 'text', text: buildSystemPrompt() }] });
    }
    this.tools = [...builtinTools, createSkillTool(this.registry, this.session)];
  }

  subscribe(handler: (ev: CoreEvent) => void): () => void {
    return this.session.bus.subscribe(handler);
  }

  /** Replace the permission handler (the REPL installs its own here). */
  setAskPermission(ask: (action: string, target: string) => Promise<boolean>): void {
    this.askPermission = ask;
  }

  get skills(): SkillInfo[] {
    return this.registry.list();
  }

  /** Snapshot the current session (used by the CLI for manual saves). */
  getSessionState(): SessionState {
    return this.session.getState();
  }

  async loadSkill(name: string): Promise<SkillInfo> {
    const skill = this.registry.get(name);
    if (!skill) throw new Error(`Unknown skill: ${name}`);
    if (!this.session.isSkillLoaded(name)) {
      this.session.markSkillLoaded(name);
      this.session.addMessage({
        role: 'user',
        content: [{ type: 'text', text: `[Skill: ${name}]\n\n${skill.body}` }],
      });
    }
    return skill;
  }

  async run(prompt: string): Promise<string> {
    const result = await runAgent({
      client: this.client,
      session: this.session,
      prompt,
      tools: this.tools,
      cwd: this.cwd,
      askPermission: this.askPermission,
      maxIterations: this.maxIterations,
      maxContextTokens: this.maxContextTokens,
    });
    await this.persist();
    return result;
  }

  async dispose(): Promise<void> {
    await this.persist();
    this.session.dispose();
  }

  private async persist(): Promise<void> {
    if (this.sessionStore) {
      await this.sessionStore.save(this.getSessionState(), { cwd: this.cwd });
    }
  }
}
```

> Note: `run()` now forwards `maxContextTokens` to `runAgent` before `RunAgentParams` accepts it (added in Task F). Type-stripped execution ignores the extra property; the types reconcile at Task F.

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test tests/core/engine.test.ts`
Expected: PASS (10 tests — 7 existing + 3 new)

- [ ] **Step 6: Commit**

```bash
git add src/core/events.ts src/core/engine.ts tests/core/engine.test.ts tests/core/cache-stability.test.ts
git commit -m "feat: engine session restore, auto-save, and context budget"
```

---

## Task F: Loop trimming + context_trim rendering

**Files:**
- Modify: `src/agent/loop.ts`
- Modify: `src/cli/render.ts`
- Test: `tests/agent/loop.test.ts`

**Interfaces:**
- Consumes: `trimHistory` from `./context.ts` (Task A), `context_trim` event (Task E), `CoreEvent` from `../core/events.ts`
- Produces:
  - `RunAgentParams` gains `maxContextTokens?: number`
  - `runAgent` trims before each iteration (only when `maxContextTokens` is set) and emits `context_trim` on `session.bus` when a trim happens
  - `renderEvent` renders `context_trim` as a dim line

- [ ] **Step 1: Write the failing test (append to `tests/agent/loop.test.ts`)**

```ts
test('trims old turns when over budget and emits context_trim', async () => {
  const seen: string[] = [];
  const session = makeSession();
  session.addMessage({ role: 'system', content: [{ type: 'text', text: 'sys' }] });
  const client: AiClient = {
    async *streamChat(params) {
      seen.push(JSON.stringify(params.messages));
      yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } };
    },
  };
  const got: string[] = [];
  session.bus.subscribe((ev) => { if (ev.type === 'context_trim') got.push(`${ev.dropped}/${ev.kept}`); });
  await runAgent({ client, session, prompt: 'p1', tools: [], ...CTX, maxContextTokens: 10 });
  await runAgent({ client, session, prompt: 'p2', tools: [], ...CTX, maxContextTokens: 10 });
  await runAgent({ client, session, prompt: 'p3', tools: [], ...CTX, maxContextTokens: 10 });
  const last = seen[seen.length - 1];
  assert.ok(!last.includes('p1'));      // oldest turn trimmed before run 3's request
  assert.ok(last.includes('p3'));       // newest prompt kept
  assert.ok(got.length >= 1);           // at least one context_trim emitted
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/agent/loop.test.ts`
Expected: FAIL — `params.maxContextTokens` is unused (no trimming, so `p1` is still in `last`)

- [ ] **Step 3: Write the implementation**

In `src/agent/loop.ts`, add `maxContextTokens?: number` to `RunAgentParams`:

```ts
export interface RunAgentParams {
  client: AiClient;
  session: Session;
  prompt: string;
  tools: Tool[];
  cwd: string;
  askPermission: (action: string, target: string) => Promise<boolean>;
  maxIterations?: number;
  /** History budget in estimated tokens; trimming runs before each iteration. */
  maxContextTokens?: number;
}
```

Add the import:

```ts
import { trimHistory } from './context.ts';
```

Inside `runAgent`, at the top of the `for` loop (before the `streamChat` call):

```ts
  for (let i = 0; i < maxIterations; i++) {
    // Cache-aware history trim (design §4.4): before each model request, drop
    // oldest whole turns over budget. Emit context_trim only when something changed.
    if (params.maxContextTokens !== undefined) {
      const before = session.getMessages();
      const trimmed = trimHistory(before, { maxTokens: params.maxContextTokens });
      if (trimmed !== before) {
        session.replaceMessages(trimmed);
        session.bus.emit({
          type: 'context_trim',
          dropped: before.length - trimmed.length,
          kept: trimmed.length,
        });
      }
    }
    const events: StreamEvent[] = [];
```

- [ ] **Step 4: Render the event (modify `src/cli/render.ts`)**

Add a case to the `renderEvent` switch:

```ts
    case 'context_trim': process.stdout.write(`\n${renderText(`— context trimmed: ${ev.kept} messages kept —`, 'dim')}\n`); break;
```

- [ ] **Step 5: Run the loop + full suite**

Run: `node --test tests/agent/loop.test.ts`
Expected: PASS (7 tests — 6 existing + 1 new)

Run: `npm test`
Expected: all tests pass (existing 98 + new)

- [ ] **Step 6: Commit**

```bash
git add src/agent/loop.ts src/cli/render.ts tests/agent/loop.test.ts
git commit -m "feat: trim history per iteration and render context_trim"
```

---

## Task G: Config, CLI --resume, exports, README

**Files:**
- Modify: `src/config/config.ts`
- Modify: `src/cli/main.ts`
- Modify: `src/core/index.ts`
- Modify: `src/index.ts`
- Modify: `README.md`
- Test: `tests/config/config.test.ts`

**Interfaces:**
- Consumes: `SessionStore`, `SessionState`, `DEFAULT_MAX_CONTEXT_TOKENS`, engine options (Tasks C, E)
- Produces:
  - `DaedalusConfig.maxContextTokens?: number`; `resolveConfig` reads `DAEDALUS_MAX_CONTEXT_TOKENS` (env over file, invalid → dropped)
  - CLI `--resume [id]` (no id = `store.latest()`); engine built with `sessionStore` + `maxContextTokens`; `await engine.dispose()`
  - core + root index exports for `SessionStore`/`SessionMeta`/`StoredSession`/`SessionState`/`trimHistory`/`estimateTokens`/`TrimOptions`/`MIN_KEEP_TURNS`/`DEFAULT_MAX_CONTEXT_TOKENS`

- [ ] **Step 1: Write the failing config tests (append to `tests/config/config.test.ts`)**

```ts
test('DAEDALUS_MAX_CONTEXT_TOKENS parses into maxContextTokens', () => {
  const cfg = loadConfig({ ANTHROPIC_API_KEY: 'sk-ant-1', DAEDALUS_CONFIG_PATH: NO_CONFIG_PATH, DAEDALUS_MAX_CONTEXT_TOKENS: '50000' } as NodeJS.ProcessEnv);
  assert.equal(cfg.maxContextTokens, 50000);
});

test('invalid DAEDALUS_MAX_CONTEXT_TOKENS is dropped', () => {
  const cfg = loadConfig({ ANTHROPIC_API_KEY: 'sk-ant-1', DAEDALUS_CONFIG_PATH: NO_CONFIG_PATH, DAEDALUS_MAX_CONTEXT_TOKENS: 'abc' } as NodeJS.ProcessEnv);
  assert.equal(cfg.maxContextTokens, undefined);
});

test('maxContextTokens from the config file is exposed', () => {
  const configPath = tempConfigFile(JSON.stringify({ provider: 'openai', apiKey: 'sk-file', maxContextTokens: 200000 }));
  const cfg = loadConfig({ DAEDALUS_CONFIG_PATH: configPath } as NodeJS.ProcessEnv);
  assert.equal(cfg.maxContextTokens, 200000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/config/config.test.ts`
Expected: FAIL — `cfg.maxContextTokens` is `undefined`

- [ ] **Step 3: Implement config support**

In `src/config/config.ts`:

```ts
export interface DaedalusConfig {
  provider: AiProviderName;
  apiKey: string;
  baseURL?: string;
  model?: string;
  maxContextTokens?: number;
}

interface FileConfig {
  provider?: string;
  apiKey?: string;
  baseURL?: string;
  model?: string;
  maxContextTokens?: number;
}
```

In `resolveConfig`, parse the env value and merge:

```ts
  const envTokens = env.DAEDALUS_MAX_CONTEXT_TOKENS === undefined ? undefined : Number(env.DAEDALUS_MAX_CONTEXT_TOKENS);
  const rawTokens = envTokens ?? file.maxContextTokens;
  const maxContextTokens = typeof rawTokens === 'number' && Number.isFinite(rawTokens) ? rawTokens : undefined;
  return {
    provider,
    apiKey,
    baseURL: env.DAEDALUS_BASE_URL ?? file.baseURL,
    model: env.DAEDALUS_MODEL ?? file.model,
    ...(maxContextTokens !== undefined ? { maxContextTokens } : {}),
  };
```

- [ ] **Step 4: Implement `--resume` in `src/cli/main.ts`**

Update imports and parseFlags:

```ts
import { SessionStore } from '../core/session-store.ts';
import type { SessionState } from '../core/session.ts';
import { DEFAULT_MAX_CONTEXT_TOKENS } from '../core/engine.ts';

function parseFlags(argv: string[]) {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--provider') flags.provider = argv[++i];
    else if (a === '--model') flags.model = argv[++i];
    else if (a === '--base-url') flags.baseUrl = argv[++i];
    else if (a === '--resume') {
      const next = argv[i + 1];
      flags.resume = next && !next.startsWith('-') ? argv[++i] : '1';
    }
    else if (a === '--help') flags.help = '1';
  }
  return flags;
}
```

After `createAiClient(config)`, before building the engine, resolve the session store and initial state:

```ts
const store = new SessionStore();
let initialState: SessionState | undefined;
if (flags.resume) {
  const meta = flags.resume === '1' ? await store.latest() : { id: flags.resume };
  if (meta) {
    try {
      const loaded = await store.load(meta.id);
      initialState = { messages: loaded.messages, loadedSkills: loaded.loadedSkills };
      console.log(`${ANSI.dim}resumed session ${loaded.id} (${loaded.messages.length} messages)${ANSI.reset}`);
    } catch (e) {
      console.error(`${ANSI.red}Failed to resume: ${(e as Error).message}${ANSI.reset}`);
    }
  } else {
    console.error(`${ANSI.red}No session to resume.${ANSI.reset}`);
  }
}
```

Build the engine with the new options and await dispose:

```ts
const engine = new DaedalusEngine({
  client,
  cwd: process.cwd(),
  initialState,
  sessionStore: store,
  maxContextTokens: base.maxContextTokens,
});
engine.subscribe(renderEvent);
await runRepl(engine);
await engine.dispose();
```

Update the `--help` text to mention `--resume [id]`:

```ts
  console.log('daedalus — a terminal agent\n\nUsage: daedalus [--provider openai|anthropic] [--model M] [--base-url URL] [--resume [id]]\n\nConfig: ~/.daedalus/config.json and DAEDALUS_* env vars. First run starts an interactive setup.');
```

> Note: `base.maxContextTokens` is `undefined` when unset — the engine falls back to `DEFAULT_MAX_CONTEXT_TOKENS`. `DAEDALUS_MAX_CONTEXT_TOKENS` set in the environment flows through `resolveConfig`/`loadConfig` automatically.

- [ ] **Step 5: Update the index exports**

`src/core/index.ts` — add:

```ts
export { SessionStore } from './session-store.ts';
export type { SessionMeta, StoredSession } from './session-store.ts';
export type { SessionState } from './session.ts';
export { DEFAULT_MAX_CONTEXT_TOKENS } from './engine.ts';
```

`src/index.ts` — add (keeping the existing core block):

```ts
export { estimateTokens, trimHistory } from './agent/context.ts';
export type { TrimOptions } from './agent/context.ts';
export { SessionStore } from './core/session-store.ts';
export type { SessionMeta, StoredSession } from './core/session-store.ts';
export type { SessionState } from './core/session.ts';
export { DEFAULT_MAX_CONTEXT_TOKENS } from './core/engine.ts';
```

- [ ] **Step 6: Update README**

Add a "Sessions & context" section documenting:
- Auto-save: each completed `run()` (and `dispose()`) persists the session to `~/.daedalus/sessions/<id>.json` (override dir with `DAEDALUS_SESSIONS_DIR`).
- Resume: `daedalus --resume` (latest) / `daedalus --resume <id>` (specific). The persisted system prompt is reused verbatim so the cache prefix stays stable.
- Budget: history is trimmed at whole-turn boundaries when the estimate exceeds `maxContextTokens` (default 100,000, env `DAEDALUS_MAX_CONTEXT_TOKENS`, config `maxContextTokens`); skill bodies are never trimmed; a `— context trimmed: N messages kept —` line is shown.
- Deferred: REPL `/sessions` & `/resume` commands, model-driven summarization, exact token counting.

- [ ] **Step 7: Run the full suite + a smoke test**

Run: `npm test`
Expected: all tests pass

Smoke test the resume flow end-to-end with a mock client (no network):

```bash
node --input-type=module -e '
import { SessionStore } from "./src/core/session-store.ts";
import { DaedalusEngine } from "./src/core/engine.ts";
const client = { async *streamChat({ messages }) {
  const last = [...messages].reverse().find((m) => m.role === "user");
  const text = last?.content?.[0]?.text ?? "";
  yield { type: "done", message: { role: "assistant", content: [{ type: "text", text: "ok:" + text }] } };
} };
const store = new SessionStore("/tmp/dae-smoke-sessions");
const e1 = new DaedalusEngine({ client, cwd: process.cwd(), sessionStore: store });
await e1.run("first turn");
await e1.dispose();
const meta = await store.latest();
const loaded = await store.load(meta.id);
const e2 = new DaedalusEngine({ client, cwd: process.cwd(), sessionStore: store, initialState: { messages: loaded.messages, loadedSkills: loaded.loadedSkills } });
const out = await e2.run("second turn");
console.log(out);
await e2.dispose();
'
```

Expected: prints `ok:second turn` (the first turn's history is visible to the resumed engine — `first turn` text is in the client's `messages`).

- [ ] **Step 8: Commit**

```bash
git add src/config/config.ts src/cli/main.ts src/core/index.ts src/index.ts README.md tests/config/config.test.ts
git commit -m "feat: wire --resume, maxContextTokens config, and public exports"
```

---

## Self-Review

**Spec coverage:**
- §3.1 SessionStore (dir, id slug, atomic write, corrupt handling, list/latest/remove) → Task C
- §3.2 Session state methods + verbatim system-message reuse → Task B + Task E
- §3.3 Engine `initialState`/`sessionStore`/`maxContextTokens`/`getSessionState`/auto-save/dispose → Task E
- §3.4 CLI `--resume [id]` (latest + by id) → Task G
- §4.1 rare-trigger/big-step/turn-boundary/MIN_KEEP_TURNS/keep-prefix → Task A + Task F (integration)
- §4.2 estimateTokens heuristic → Task A
- §4.3 trimHistory + protected skill bodies (content marker, both injection paths) → Task A + Task D
- §4.4 `context_trim` event + render + post-trim persistence → Task E (event), Task F (emit + render), Task E (persist)
- §4.5 cache interplay (rare miss, prefix rebuild) → Task A design + existing cache-stability tests (unchanged)
- §5 `maxContextTokens` config + `DAEDALUS_MAX_CONTEXT_TOKENS` → Task G
- §6 file structure → Tasks A–G match the modified/new lists
- §7 task decomposition → preserved (B/C swapped for dependency cleanliness; skill-tool marker moved to its own Task D; design's Task D–F split into E/F)

**Placeholder scan:** No TBD/TODO. Every code step carries full implementation or a concrete mechanical command. The `SessionStore` unused `Message` import is flagged explicitly. Task E's `runAgent({ ..., maxContextTokens })` forward-reference is explained (additive field; types reconcile at Task F).

**Type consistency:**
- `SessionState` defined Task B, consumed Task C (`save(state: SessionState)`), Task E (`initialState?: SessionState`, `getSessionState()`), Task G (`initialState`) ✓
- `SessionStore.save(state, meta?)` / `load(id)` / `list()` / `latest()` / `remove(id)` Task C, used Task E (`store.save(state, { cwd })`, `store.list()`, `store.load(id)`) and Task G (`store.latest()`, `store.load(id)`) ✓
- `trimHistory(messages, { maxTokens, estimate?, isProtected? })` Task A, used Task F (`{ maxTokens }`) and tests ✓
- `context_trim { dropped, kept }` event added Task E, emitted Task F, rendered Task F ✓
- `RunAgentParams.maxContextTokens?` added Task F, forwarded by Task E's `run()` ✓
- `dispose(): Promise<void>` Task E, awaited in engine/cache tests (Task E sed) and main.ts (Task G) ✓
- `DEFAULT_MAX_CONTEXT_TOKENS` exported from engine Task E, imported by main.ts Task G ✓

**Known follow-ups (out of scope, per design §8):** REPL `/sessions`/`/resume`, model-driven summarization via the reserved trim interface, exact token counting.
