# Skills + Session Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add persistent sessions (a `DaedalusEngine` facade owning a `Session`) and Markdown skills (a single `Skill` tool whose full body loads on demand via tool_result) to Daedalus.

**Architecture:** Introduce a UI-agnostic core layer (`src/core/`) with `DaedalusEngine` as the single facade, owning the `Session` (MessageHistory + loaded-skill state), the `SkillRegistry`, the tool registry, and the AI client. `src/cli/` becomes one consumer of the core. Skill bodies are carried by a `Skill` tool's tool_result (a user-role message), staying in history for the session — cache-safe because nothing above the system-prompt breakpoint changes.

**Tech Stack:** TypeScript (Node 24 native type-stripping), zero runtime dependencies, `node:test` for testing.

## Global Constraints

- **No node-gyp:** never add any dependency that directly or indirectly requires node-gyp. Any `npm install` must be approved by the user first. This plan adds **zero new dependencies**.
- **Prompt-caching maximization:** system prompt prefix must stay stable; variable content (skill bodies, tool results) goes into conversation messages, never into the system prompt. `cache: { enabled: true }` stays on `streamChat`.
- **Core does not depend on CLI/UI.** CLI imports core only; core imports nothing from `src/cli/`.
- **TypeScript conventions:** `erasableSyntaxOnly: true` — no enums, no namespaces, no constructor parameter properties. Imports use explicit `.ts` extensions. `target: ES2022` — no ES2023+ methods (no `findLast`, no `toSorted`).
- **Testing:** `node --test 'tests/**/*.test.ts'`. All 45 existing tests must keep passing.
- **Skill dirs:** project `.claude/skills/` (starting dir + parents up to repo root, highest precedence) then `~/.daedalus/skills/`.

---

## File Structure

**New core files:**
- `src/core/events.ts` — `CoreEvent` union, `EventBus` (typed pub/sub)
- `src/core/session.ts` — `Session` (MessageHistory + loadedSkills), lifecycle events
- `src/core/skills/types.ts` — `SkillInfo`, `SkillFrontmatter`
- `src/core/skills/registry.ts` — `SkillRegistry` (discovery, parse, listing)
- `src/core/skills/skill-tool.ts` — the `Skill` tool definition
- `src/core/system-prompt.ts` — `buildSystemPrompt()`
- `src/core/engine.ts` — `DaedalusEngine` facade
- `src/core/index.ts` — core public exports

**Modified files:**
- `src/agent/loop.ts` — refactor to accept a `Session`, `cwd`, `askPermission`; broadcast events on the session bus
- `src/cli/main.ts` — construct `DaedalusEngine`, pass it to `runRepl`
- `src/cli/repl.ts` — take an `EngineLike`, handle `/skill-name` and `/skills`, call `engine.run`
- `src/cli/render.ts` — render `CoreEvent` (incl. `skill_load`)
- `src/index.ts` — export `DaedalusEngine` + core types

**New test files:**
- `tests/core/events.test.ts`
- `tests/core/session.test.ts`
- `tests/core/skills/registry.test.ts`
- `tests/core/skills/skill-tool.test.ts`
- `tests/core/system-prompt.test.ts`
- `tests/core/engine.test.ts`
- `tests/core/cache-stability.test.ts`
- `tests/cli/repl.test.ts`

---

## Task 1: Core Event Bus + CoreEvent types

**Files:**
- Create: `src/core/events.ts`
- Test: `tests/core/events.test.ts`

**Interfaces:**
- Consumes: `Message` from `../ai/types.ts`, `AiError` from `../ai/errors.ts`
- Produces: `type CoreEvent` (union), `class EventBus` with `subscribe(handler): () => void`, `emit(event)`, `emitAll(events)`

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../../src/core/events.ts';
import type { CoreEvent } from '../../src/core/events.ts';

test('subscribe receives emitted events', () => {
  const bus = new EventBus();
  const got: CoreEvent[] = [];
  const unsub = bus.subscribe((ev) => got.push(ev));
  bus.emit({ type: 'session_start' });
  bus.emit({ type: 'text_delta', text: 'hi' });
  assert.equal(got.length, 2);
  assert.equal(got[0].type, 'session_start');
  assert.equal(got[1].type, 'text_delta');
  unsub();
});

test('unsubscribe stops delivery and is idempotent', () => {
  const bus = new EventBus();
  let count = 0;
  const unsub = bus.subscribe(() => count++);
  bus.emit({ type: 'session_start' });
  unsub();
  unsub();
  bus.emit({ type: 'session_end' });
  assert.equal(count, 1);
});

test('emitAll emits in order', () => {
  const bus = new EventBus();
  const got: string[] = [];
  bus.subscribe((ev) => got.push(ev.type));
  bus.emitAll([{ type: 'session_start' }, { type: 'session_end' }]);
  assert.deepEqual(got, ['session_start', 'session_end']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/core/events.test.ts`
Expected: FAIL — "Cannot find module" / `EventBus` not exported

- [ ] **Step 3: Write minimal implementation**

```ts
import type { Message } from '../ai/types.ts';
import type { AiError } from '../ai/errors.ts';

export type CoreEvent =
  | { type: 'session_start' }
  | { type: 'session_end' }
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'tool_call_start'; id: string; name: string }
  | { type: 'tool_call_delta'; id: string; inputDelta: string }
  | { type: 'skill_load'; name: string }
  | { type: 'done'; message: Message }
  | { type: 'error'; error: AiError };

type Handler = (ev: CoreEvent) => void;

export class EventBus {
  private handlers = new Set<Handler>();
  subscribe(handler: Handler): () => void {
    this.handlers.add(handler);
    return () => { this.handlers.delete(handler); };
  }
  emit(ev: CoreEvent): void {
    for (const h of this.handlers) h(ev);
  }
  emitAll(events: Iterable<CoreEvent>): void {
    for (const ev of events) this.emit(ev);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/core/events.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/events.ts tests/core/events.test.ts
git commit -m "feat: add core event bus and CoreEvent types"
```

---

## Task 2: Session

**Files:**
- Create: `src/core/session.ts`
- Test: `tests/core/session.test.ts`

**Interfaces:**
- Consumes: `Message` from `../ai/types.ts`, `EventBus` from `./events.ts`
- Produces: `class Session` with:
  - `readonly bus: EventBus`
  - `start(): void` (emits `session_start`)
  - `dispose(): void` (emits `session_end`)
  - `addMessage(m: Message): void`
  - `getMessages(): Message[]`
  - `markSkillLoaded(name: string): void` (emits `skill_load`)
  - `isSkillLoaded(name: string): boolean`
  - `getLoadedSkills(): string[]`

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/core/session.test.ts`
Expected: FAIL — "Cannot find module" / `Session` not exported

- [ ] **Step 3: Write minimal implementation**

```ts
import type { Message } from '../ai/types.ts';
import { EventBus } from './events.ts';

export class Session {
  readonly bus = new EventBus();
  private msgs: Message[] = [];
  private skills = new Set<string>();

  start(): void {
    this.bus.emit({ type: 'session_start' });
  }

  dispose(): void {
    this.bus.emit({ type: 'session_end' });
  }

  addMessage(m: Message): void {
    this.msgs.push(m);
  }

  getMessages(): Message[] {
    return this.msgs;
  }

  markSkillLoaded(name: string): void {
    if (this.skills.has(name)) return;
    this.skills.add(name);
    this.bus.emit({ type: 'skill_load', name });
  }

  isSkillLoaded(name: string): boolean {
    return this.skills.has(name);
  }

  getLoadedSkills(): string[] {
    return [...this.skills];
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/core/session.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/session.ts tests/core/session.test.ts
git commit -m "feat: add Session with lifecycle, history, and skill-load state"
```

---

## Task 3: Skill types + SkillRegistry (discovery, parse, listing)

**Files:**
- Create: `src/core/skills/types.ts`
- Create: `src/core/skills/registry.ts`
- Test: `tests/core/skills/registry.test.ts`

**Interfaces:**
- Consumes: Node builtins (`node:fs`, `node:path`, `node:os`) only
- Produces:
  - `interface SkillInfo { name: string; description: string; whenToUse?: string; body: string; userInvocable: boolean; }`
  - `interface SkillFrontmatter { name?: string; description?: string; 'when_to_use'?: string; 'allowed-tools'?: unknown; 'disallowed-tools'?: unknown; 'disable-model-invocation'?: boolean; 'user-invocable'?: boolean; }`
  - `class SkillRegistry` with:
    - `constructor(skillDirs?: string[])` — dirs in precedence order (highest first); default = project `.claude/skills` chain + `~/.daedalus/skills`
    - `get names(): string[]`
    - `get(name: string): SkillInfo | undefined`
    - `list(): SkillInfo[]`
    - `renderListing(maxChars: number): string` — "name — description" lines, budgeted
  - `function parseSkillDir(dir: string): SkillInfo | null` (exported for direct test)

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillRegistry, parseSkillDir } from '../../src/core/skills/registry.ts';

function makeSkill(base: string, name: string, content: string): void {
  mkdirSync(join(base, name), { recursive: true });
  writeFileSync(join(base, name, 'SKILL.md'), content);
}

test('parseSkillDir reads frontmatter and body', () => {
  const base = join(tmpdir(), `dae-sk-${Date.now()}`);
  mkdirSync(base, { recursive: true });
  makeSkill(base, 'review', `---
name: review
description: Review code
when_to_use: On code review requests
user-invocable: true
---
Body text here`);
  const info = parseSkillDir(join(base, 'review'));
  assert.ok(info);
  assert.equal(info.name, 'review');
  assert.equal(info.description, 'Review code');
  assert.equal(info.whenToUse, 'On code review requests');
  assert.equal(info.body, 'Body text here');
  assert.equal(info.userInvocable, true);
  rmSync(base, { recursive: true, force: true });
});

test('name falls back to directory name when omitted', () => {
  const base = join(tmpdir(), `dae-sk-${Date.now()}`);
  mkdirSync(base, { recursive: true });
  makeSkill(base, 'dir-name', `---
description: No name here
---
Body`);
  const info = parseSkillDir(join(base, 'dir-name'));
  assert.ok(info);
  assert.equal(info.name, 'dir-name');
  rmSync(base, { recursive: true, force: true });
});

test('missing SKILL.md returns null', () => {
  const base = join(tmpdir(), `dae-sk-${Date.now()}`);
  mkdirSync(base, { recursive: true });
  mkdirSync(join(base, 'nodoc'));
  assert.equal(parseSkillDir(join(base, 'nodoc')), null);
  rmSync(base, { recursive: true, force: true });
});

test('registry discovers skills in dirs and respects precedence', () => {
  const userDir = join(tmpdir(), `dae-user-${Date.now()}`);
  const projDir = join(tmpdir(), `dae-proj-${Date.now()}`);
  mkdirSync(userDir, { recursive: true });
  mkdirSync(projDir, { recursive: true });
  makeSkill(userDir, 'dup', '---\nname: dup\ndescription: user version\n---\nuser');
  makeSkill(userDir, 'only-user', '---\nname: only-user\ndescription: U\n---\nu');
  makeSkill(projDir, 'dup', '---\nname: dup\ndescription: proj version\n---\nproj');
  const reg = new SkillRegistry([projDir, userDir]); // proj first = higher precedence
  assert.equal(reg.get('dup')!.description, 'proj version');
  assert.equal(reg.get('only-user')!.description, 'U');
  rmSync(userDir, { recursive: true, force: true });
  rmSync(projDir, { recursive: true, force: true });
});

test('renderListing is budgeted to maxChars', () => {
  const base = join(tmpdir(), `dae-sk-${Date.now()}`);
  mkdirSync(base, { recursive: true });
  makeSkill(base, 'aaa', '---\nname: aaa\ndescription: A very long description for aaa\n---\nb');
  makeSkill(base, 'bbb', '---\nname: bbb\ndescription: B\n---\nb');
  const reg = new SkillRegistry([base]);
  const listing = reg.renderListing(20);
  assert.ok(listing.length <= 20);
  assert.ok(listing.includes('bbb'));
  rmSync(base, { recursive: true, force: true });
});

test('default constructor discovers from project .claude/skills chain', () => {
  const reg = new SkillRegistry();
  assert.ok(Array.isArray(reg.names));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/core/skills/registry.test.ts`
Expected: FAIL — "Cannot find module"

- [ ] **Step 3: Write minimal implementation**

```ts
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

export interface SkillInfo {
  name: string;
  description: string;
  whenToUse?: string;
  body: string;
  userInvocable: boolean;
}

export interface SkillFrontmatter {
  name?: string;
  description?: string;
  'when_to_use'?: string;
  'allowed-tools'?: unknown;
  'disallowed-tools'?: unknown;
  'disable-model-invocation'?: boolean;
  'user-invocable'?: boolean;
}

/** Small YAML-subset parser: `key: value` scalar lines. Non-scalar content is skipped. */
function parseFrontmatter(raw: string): SkillFrontmatter {
  const out: Record<string, unknown> = {};
  for (const line of raw.split('\n')) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    const key = m[1];
    const val = m[2].trim().replace(/^["']|["']$/g, '');
    if (val === '') continue;
    if (key === 'disable-model-invocation' || key === 'user-invocable') {
      out[key] = val === 'true';
    } else {
      out[key] = val;
    }
  }
  return out as SkillFrontmatter;
}

export function parseSkillDir(dir: string): SkillInfo | null {
  const mdPath = join(dir, 'SKILL.md');
  let raw: string;
  try {
    raw = readFileSync(mdPath, 'utf8');
  } catch {
    return null;
  }
  const fence = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  let fm: SkillFrontmatter = {};
  let body = raw;
  if (fence) {
    fm = parseFrontmatter(fence[1]);
    body = raw.slice(fence[0].length).trimStart();
  }
  return {
    name: fm.name ?? dirname(dir).endsWith('/') ? '' : dirname(dir).split(/[\\/]/).pop() ?? '',
    description: fm.description ?? '',
    whenToUse: fm.when_to_use,
    body,
    userInvocable: fm['user-invocable'] !== false,
  };
}

/** Discover `.claude/skills` in cwd and every parent up to fs root. */
function findProjectSkillDirs(cwd: string): string[] {
  const dirs: string[] = [];
  let cur = cwd;
  for (;;) {
    const candidate = join(cur, '.claude', 'skills');
    if (existsSync(candidate)) dirs.push(candidate);
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return dirs;
}

export class SkillRegistry {
  private byName = new Map<string, SkillInfo>();

  constructor(skillDirs?: string[]) {
    const dirs = skillDirs ?? [
      ...findProjectSkillDirs(process.cwd()),
      join(homedir(), '.daedalus', 'skills'),
    ];
    for (const dir of dirs) this.loadDir(dir);
  }

  private loadDir(dir: string): void {
    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const info = parseSkillDir(join(dir, e.name));
      if (!info) continue;
      if (!this.byName.has(info.name)) this.byName.set(info.name, info); // first wins
    }
  }

  get names(): string[] {
    return [...this.byName.keys()];
  }

  get(name: string): SkillInfo | undefined {
    return this.byName.get(name);
  }

  list(): SkillInfo[] {
    return [...this.byName.values()];
  }

  renderListing(maxChars: number): string {
    const lines: string[] = [];
    let total = 0;
    for (const s of this.list()) {
      const entry = `${s.name} — ${s.description}`;
      const add = lines.length === 0 ? entry.length : entry.length + 1;
      if (total + add > maxChars) break;
      lines.push(entry);
      total += add;
    }
    return lines.join('\n');
  }
}
```

> **Note on `parseSkillDir` name fallback:** the inline expression above is convoluted. Use `basename(dir)` instead — import `basename` from `node:path` and write `name: fm.name ?? basename(dir)`. The test expects directory-name fallback.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/core/skills/registry.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/skills/types.ts src/core/skills/registry.ts tests/core/skills/registry.test.ts
git commit -m "feat: add SkillRegistry with discovery, frontmatter parsing, and listing"
```

---

## Task 4: Skill tool

**Files:**
- Create: `src/core/skills/skill-tool.ts`
- Test: `tests/core/skills/skill-tool.test.ts`

**Interfaces:**
- Consumes: `Tool` type from `../../tools/types.ts`, `SkillRegistry` from `./registry.ts`, `Session` from `../session.ts`
- Produces: `function createSkillTool(registry: SkillRegistry, session: Session): Tool`
  — a `Tool` named `Skill`, description includes `registry.renderListing(1500)`, `execute` validates, marks loaded, dedups; unknown name → `{ isError: true }` result

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillRegistry } from '../../src/core/skills/registry.ts';
import { createSkillTool } from '../../src/core/skills/skill-tool.ts';
import { Session } from '../../src/core/session.ts';
import type { ToolContext } from '../../src/tools/types.ts';

function regWith(names: string[]): SkillRegistry {
  const base = join(tmpdir(), `dae-stool-${Date.now()}`);
  mkdirSync(base, { recursive: true });
  for (const n of names) {
    mkdirSync(join(base, n), { recursive: true });
    writeFileSync(join(base, n, 'SKILL.md'), `---\nname: ${n}\ndescription: desc for ${n}\n---\nBody of ${n}`);
  }
  return new SkillRegistry([base]);
}

function ctx(): ToolContext {
  return { cwd: process.cwd(), askPermission: async () => true };
}

test('Skill tool description includes registry listing', () => {
  const tool = createSkillTool(regWith(['review']), new Session());
  assert.ok(tool.description.includes('review'));
  assert.equal(tool.name, 'Skill');
});

test('Skill tool returns rendered body as content and marks loaded', async () => {
  const session = new Session();
  const tool = createSkillTool(regWith(['review']), session);
  const res = await tool.execute({ name: 'review' }, ctx());
  assert.equal(res.isError, undefined);
  assert.ok(res.content.includes('Body of review'));
  assert.equal(session.isSkillLoaded('review'), true);
});

test('re-invoking same skill returns dedup note, no second body', async () => {
  const session = new Session();
  const tool = createSkillTool(regWith(['review']), session);
  await tool.execute({ name: 'review' }, ctx());
  const res2 = await tool.execute({ name: 'review' }, ctx());
  assert.ok(res2.content.includes('already loaded'));
  assert.ok(!res2.content.includes('Body of review'));
});

test('unknown skill name returns error result', async () => {
  const tool = createSkillTool(regWith(['review']), new Session());
  const res = await tool.execute({ name: 'nope' }, ctx());
  assert.equal(res.isError, true);
  assert.ok(res.content.includes('Unknown skill'));
});

test('missing name returns error result', async () => {
  const tool = createSkillTool(regWith(['review']), new Session());
  const res = await tool.execute({}, ctx());
  assert.equal(res.isError, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/core/skills/skill-tool.test.ts`
Expected: FAIL — "Cannot find module"

- [ ] **Step 3: Write minimal implementation**

```ts
import type { Tool, ToolContext, ToolResult } from '../../tools/types.ts';
import type { SkillRegistry } from './registry.ts';
import type { Session } from '../session.ts';

const LISTING_BUDGET = 1500;

export function createSkillTool(registry: SkillRegistry, session: Session): Tool {
  return {
    name: 'Skill',
    description: `Load a skill by name. Skills provide instructions that guide the conversation. Available skills:\n${registry.renderListing(LISTING_BUDGET) || '(none)'}`,
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
    async execute(input: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const name = (input as { name?: string }).name;
      if (!name) return { content: 'Missing skill name', isError: true };
      const skill = registry.get(name);
      if (!skill) return { content: `Unknown skill: ${name}`, isError: true };
      if (session.isSkillLoaded(name)) {
        return { content: `Skill "${name}" is already loaded.` };
      }
      session.markSkillLoaded(name);
      return { content: skill.body };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/core/skills/skill-tool.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/skills/skill-tool.ts tests/core/skills/skill-tool.test.ts
git commit -m "feat: add Skill tool with registry-backed loading and dedup"
```

---

## Task 5: System prompt builder

**Files:**
- Create: `src/core/system-prompt.ts`
- Test: `tests/core/system-prompt.test.ts`

**Interfaces:**
- Consumes: nothing external
- Produces: `function buildSystemPrompt(): string`

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt } from '../../src/core/system-prompt.ts';

test('buildSystemPrompt mentions Daedalus and tools guidance', () => {
  const p = buildSystemPrompt();
  assert.ok(p.includes('Daedalus'));
  assert.ok(p.length > 50);
});

test('buildSystemPrompt is deterministic (stable prefix)', () => {
  assert.equal(buildSystemPrompt(), buildSystemPrompt());
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/core/system-prompt.test.ts`
Expected: FAIL — "Cannot find module"

- [ ] **Step 3: Write minimal implementation**

```ts
export function buildSystemPrompt(): string {
  return [
    'You are Daedalus, a terminal agent that helps users with software engineering tasks.',
    '',
    "You have access to tools. Use them to inspect, read, write, and run commands in the user's project.",
    'When a tool call is needed, emit it; when the task is done, respond with a concise final message.',
    'Skills may be available via the Skill tool. Load one when its description matches the user request; it will provide additional instructions.',
  ].join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/core/system-prompt.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/system-prompt.ts tests/core/system-prompt.test.ts
git commit -m "feat: add core system prompt builder"
```

---

## Task 6: Refactor agent loop to use Session + EventBus

**Files:**
- Modify: `src/agent/loop.ts`
- Test: `tests/agent/loop.test.ts` (rewrite)

**Interfaces:**
- Consumes: `Session` from `src/core/session.ts`
- Produces: **new final `RunAgentParams`** (replaces the old signature — old `systemPrompt`, `onEvent` are gone; `cwd`/`askPermission` are kept):
  ```ts
  interface RunAgentParams {
    client: AiClient;
    session: Session;
    prompt: string;
    tools: Tool[];
    cwd: string;
    askPermission: (action: string, target: string) => Promise<boolean>;
    maxIterations?: number;
  }
  ```
  Returns `Promise<string>`; broadcasts every `StreamEvent` as a `CoreEvent` on `session.bus`; appends the user prompt, assistant messages, and tool results to the session's history.

- [ ] **Step 1: Rewrite the failing tests**

Replace `tests/agent/loop.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from '../../src/agent/loop.ts';
import { Session } from '../../src/core/session.ts';
import { AiError } from '../../src/ai/errors.ts';
import type { AiClient } from '../../src/ai/types.ts';
import type { Tool } from '../../src/tools/types.ts';
import type { CoreEvent } from '../../src/core/events.ts';

function makeSession(): Session {
  const s = new Session();
  s.start();
  return s;
}

const CTX = { cwd: process.cwd(), askPermission: (async () => true) as (action: string, target: string) => Promise<boolean> };

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

test('no tool calls → returns assistant text and ends', async () => {
  const client: AiClient = {
    async *streamChat() {
      yield { type: 'text_delta', text: 'hello' };
      yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } };
    },
  };
  const session = makeSession();
  const result = await runAgent({ client, session, prompt: 'hi', tools: [], ...CTX });
  assert.equal(result, 'hello');
});

test('delivers the user prompt to streamChat as a user message', async () => {
  const client: AiClient = {
    async *streamChat(params) {
      const userMsg = params.messages.find((m) => m.role === 'user' && m.content.some((c) => c.type === 'text'));
      if (!userMsg) throw new Error('no user message in messages');
      const textBlock = userMsg.content.find((c) => c.type === 'text');
      if (textBlock?.type !== 'text' || textBlock.text !== 'hi') throw new Error('user prompt mismatch');
      yield { type: 'text_delta', text: 'ok' };
      yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } };
    },
  };
  const session = makeSession();
  const result = await runAgent({ client, session, prompt: 'hi', tools: [], ...CTX });
  assert.equal(result, 'ok');
});

test('tool call → executes tool → returns tool result to AI → final text', async () => {
  let iterations = 0;
  const client: AiClient = {
    async *streamChat(params) {
      iterations++;
      if (iterations === 1) {
        yield { type: 'tool_call_start', id: 't1', name: 'myTool' };
        yield { type: 'tool_call_delta', id: 't1', inputDelta: '{"text":"x"}' };
        yield { type: 'done', message: { role: 'assistant', content: [{ type: 'tool_call', id: 't1', name: 'myTool', input: { text: 'x' } }] } };
      } else {
        const userMsg = params.messages.find((m) => m.role === 'user' && m.content.some((c) => c.type === 'tool_result'));
        assert.ok(userMsg);
        yield { type: 'text_delta', text: 'done' };
        yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } };
      }
    },
  };
  const session = makeSession();
  const result = await runAgent({ client, session, prompt: 'hi', tools: [echoTool('myTool')], ...CTX });
  assert.equal(result, 'done');
  assert.equal(iterations, 2);
});

test('tool execution receives cwd and askPermission from params', async () => {
  let gotCwd = '';
  let askCalled = false;
  const tool: Tool = {
    name: 'ctxTool',
    description: 'ctx',
    inputSchema: { type: 'object' },
    async execute(_input, ctx) {
      gotCwd = ctx.cwd;
      askCalled = await ctx.askPermission('test', 'target');
      return { content: 'ok' };
    },
  };
  const client: AiClient = {
    async *streamChat() {
      yield { type: 'done', message: { role: 'assistant', content: [{ type: 'tool_call', id: 't', name: 'ctxTool', input: {} }] } };
      yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'final' }] } };
    },
  };
  const session = makeSession();
  await runAgent({ client, session, prompt: 'hi', tools: [tool], cwd: '/tmp/ctx', askPermission: async () => { return true; } });
  assert.equal(gotCwd, '/tmp/ctx');
  assert.equal(askCalled, true);
});

test('stops after maxIterations', async () => {
  let iterations = 0;
  const client: AiClient = {
    async *streamChat() {
      iterations++;
      yield { type: 'done', message: { role: 'assistant', content: [{ type: 'tool_call', id: 't', name: 'myTool', input: {} }] } };
    },
  };
  const session = makeSession();
  const result = await runAgent({ client, session, prompt: 'hi', tools: [echoTool('myTool')], ...CTX, maxIterations: 2 });
  assert.equal(iterations, 2);
  assert.equal(result, '');
});

test('throws AiError when streamChat ends without a terminal done or error event', async () => {
  const client: AiClient = {
    async *streamChat() {
      yield { type: 'text_delta', text: 'orphan' };
    },
  };
  const session = makeSession();
  await assert.rejects(
    () => runAgent({ client, session, prompt: 'hi', tools: [], ...CTX, maxIterations: 2 }),
    (e: unknown) => e instanceof AiError && e.kind === 'protocol',
  );
});

test('broadcasts stream events as core events on session bus', async () => {
  const client: AiClient = {
    async *streamChat() {
      yield { type: 'text_delta', text: 'hi' };
      yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } };
    },
  };
  const session = makeSession();
  const got: string[] = [];
  session.bus.subscribe((ev: CoreEvent) => got.push(ev.type));
  await runAgent({ client, session, prompt: 'hi', tools: [], ...CTX });
  assert.ok(got.includes('text_delta'));
  assert.ok(got.includes('done'));
});

test('messages accumulate in session across consecutive runAgent calls', async () => {
  const session = makeSession();
  await runAgent({
    client: {
      async *streamChat() {
        yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'one' }] } };
      },
    },
    session, prompt: 'first', tools: [], ...CTX,
  });
  let sawPrior = false;
  await runAgent({
    client: {
      async *streamChat(params) {
        sawPrior = params.messages.some((m) => m.role === 'assistant' && JSON.stringify(m.content).includes('one'));
        yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'two' }] } };
      },
    },
    session, prompt: 'second', tools: [], ...CTX,
  });
  assert.equal(sawPrior, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/agent/loop.test.ts`
Expected: FAIL — type errors / old `systemPrompt` no longer accepted

- [ ] **Step 3: Rewrite the implementation**

Replace `src/agent/loop.ts` with:

```ts
import type { AiClient, StreamEvent, ToolDefinition } from '../ai/types.ts';
import type { Tool, ToolResult } from '../tools/types.ts';
import { AiError } from '../ai/errors.ts';
import type { Session } from '../core/session.ts';
import type { CoreEvent } from '../core/events.ts';

export interface RunAgentParams {
  client: AiClient;
  session: Session;
  prompt: string;
  tools: Tool[];
  cwd: string;
  askPermission: (action: string, target: string) => Promise<boolean>;
  maxIterations?: number;
}

const DEFAULT_MAX = 100;

function toCoreEvent(ev: StreamEvent): CoreEvent {
  switch (ev.type) {
    case 'text_delta': return { type: 'text_delta', text: ev.text };
    case 'thinking_delta': return { type: 'thinking_delta', thinking: ev.thinking };
    case 'tool_call_start': return { type: 'tool_call_start', id: ev.id, name: ev.name };
    case 'tool_call_delta': return { type: 'tool_call_delta', id: ev.id, inputDelta: ev.inputDelta };
    case 'done': return { type: 'done', message: ev.message };
    case 'error': return { type: 'error', error: ev.error };
  }
}

export async function runAgent(params: RunAgentParams): Promise<string> {
  const { session } = params;
  session.addMessage({ role: 'user', content: [{ type: 'text', text: params.prompt }] });

  const toolDefs: ToolDefinition[] = params.tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));

  const maxIterations = params.maxIterations ?? DEFAULT_MAX;
  let finalText = '';

  for (let i = 0; i < maxIterations; i++) {
    const events: StreamEvent[] = [];
    for await (const ev of params.client.streamChat({
      messages: session.getMessages(),
      tools: toolDefs,
      cache: { enabled: true },
    })) {
      session.bus.emit(toCoreEvent(ev));
      events.push(ev);
      if (ev.type === 'error') throw ev.error;
      if (ev.type === 'done') session.addMessage(ev.message);
    }
    let lastAssistant: StreamEvent | undefined;
    for (let j = events.length - 1; j >= 0; j--) {
      if (events[j].type === 'done') { lastAssistant = events[j]; break; }
    }
    if (!lastAssistant || lastAssistant.type !== 'done') {
      throw new AiError('protocol', 'stream ended without a terminal "done" or "error" event');
    }
    const msg = lastAssistant.message;
    finalText = msg.content.filter((c) => c.type === 'text').map((c) => (c.type === 'text' ? c.text : '')).join('');

    const calls = msg.content.filter((c) => c.type === 'tool_call');
    if (calls.length === 0) break;

    const results: ToolResult[] = [];
    for (const call of calls) {
      if (call.type !== 'tool_call') continue;
      const tool = params.tools.find((t) => t.name === call.name);
      let res: ToolResult;
      if (!tool) {
        res = { content: `Unknown tool: ${call.name}`, isError: true };
      } else {
        try { res = await tool.execute(call.input, { cwd: params.cwd, askPermission: params.askPermission }); }
        catch (e) { res = { content: (e as Error).message, isError: true }; }
      }
      results.push(res);
    }
    const resultBlocks = calls.map((call, idx) => {
      const r = results[idx];
      return {
        type: 'tool_result' as const,
        toolCallId: call.id,
        content: r.content,
        isError: r.isError,
      };
    });
    session.addMessage({ role: 'user', content: resultBlocks });
  }
  return finalText;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/agent/loop.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/loop.ts tests/agent/loop.test.ts
git commit -m "refactor: agent loop drives a Session and broadcasts core events"
```

---

## Task 7: DaedalusEngine facade

**Files:**
- Create: `src/core/engine.ts`
- Test: `tests/core/engine.test.ts`

**Interfaces:**
- Consumes: `AiClient` from `../ai/types.ts`, `tools` from `../tools/registry.ts`, `runAgent` from `../agent/loop.ts`, `Session`, `SkillRegistry`, `createSkillTool`, `buildSystemPrompt`
- Produces:
  ```ts
  interface EngineOptions {
    client: AiClient;
    cwd: string;
    askPermission: (action: string, target: string) => Promise<boolean>;
    skillDirs?: string[];
    maxIterations?: number;
  }
  class DaedalusEngine {
    constructor(opts: EngineOptions);                       // emits session_start
    subscribe(handler: (ev: CoreEvent) => void): () => void;
    run(prompt: string): Promise<string>;
    get skills(): SkillInfo[];
    loadSkill(name: string): Promise<SkillInfo>;            // marks loaded + injects body as user message
    dispose(): void;                                        // emits session_end
  }
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DaedalusEngine } from '../../src/core/engine.ts';
import type { AiClient } from '../../src/ai/types.ts';

function textClient(text: string): AiClient {
  return {
    async *streamChat() {
      yield { type: 'text_delta', text };
      yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text }] } };
    },
  };
}

function opts(overrides: Partial<{ client: AiClient; skillDirs: string[]; maxIterations: number }> = {}) {
  return {
    client: overrides.client ?? textClient('ok'),
    cwd: process.cwd(),
    askPermission: (async () => true) as (action: string, target: string) => Promise<boolean>,
    skillDirs: overrides.skillDirs ?? [],
    maxIterations: overrides.maxIterations ?? 2,
  };
}

test('run drives a single prompt through the client', async () => {
  const engine = new DaedalusEngine(opts());
  const result = await engine.run('hello');
  assert.equal(result, 'ok');
  engine.dispose();
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
  engine.dispose();
});

test('skills listing is exposed via getter', async () => {
  const base = join(tmpdir(), `dae-eng-${Date.now()}`);
  mkdirSync(join(base, 'review'), { recursive: true });
  writeFileSync(join(base, 'review', 'SKILL.md'), '---\nname: review\ndescription: Review\n---\nBody');
  const engine = new DaedalusEngine(opts({ skillDirs: [base] }));
  assert.equal(engine.skills[0].name, 'review');
  engine.dispose();
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
  engine.dispose();
  probe.dispose();
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
  engine.dispose();
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
  engine.dispose();
  rmSync(base, { recursive: true, force: true });
});

test('loadSkill with unknown name throws', async () => {
  const engine = new DaedalusEngine(opts());
  await assert.rejects(() => engine.loadSkill('nope'), /Unknown skill/);
  engine.dispose();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/core/engine.test.ts`
Expected: FAIL — "Cannot find module" / `DaedalusEngine` not exported

- [ ] **Step 3: Write minimal implementation**

```ts
import type { AiClient } from '../ai/types.ts';
import type { Tool } from '../tools/types.ts';
import { tools as builtinTools } from '../tools/registry.ts';
import type { CoreEvent } from './events.ts';
import { Session } from './session.ts';
import { SkillRegistry } from './skills/registry.ts';
import type { SkillInfo } from './skills/types.ts';
import { createSkillTool } from './skills/skill-tool.ts';
import { runAgent } from '../agent/loop.ts';

export interface EngineOptions {
  client: AiClient;
  cwd: string;
  askPermission: (action: string, target: string) => Promise<boolean>;
  skillDirs?: string[];
  maxIterations?: number;
}

export class DaedalusEngine {
  private session: Session;
  private registry: SkillRegistry;
  private tools: Tool[];
  private client: AiClient;
  private cwd: string;
  private askPermission: (action: string, target: string) => Promise<boolean>;
  private maxIterations?: number;

  constructor(opts: EngineOptions) {
    this.session = new Session();
    this.session.start();
    this.registry = new SkillRegistry(opts.skillDirs);
    this.client = opts.client;
    this.cwd = opts.cwd;
    this.askPermission = opts.askPermission;
    this.maxIterations = opts.maxIterations;
    this.tools = [...builtinTools, createSkillTool(this.registry, this.session)];
  }

  subscribe(handler: (ev: CoreEvent) => void): () => void {
    return this.session.bus.subscribe(handler);
  }

  get skills(): SkillInfo[] {
    return this.registry.list();
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
    return runAgent({
      client: this.client,
      session: this.session,
      prompt,
      tools: this.tools,
      cwd: this.cwd,
      askPermission: this.askPermission,
      maxIterations: this.maxIterations,
    });
  }

  dispose(): void {
    this.session.dispose();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/core/engine.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/engine.ts tests/core/engine.test.ts
git commit -m "feat: add DaedalusEngine facade owning session, skills, and tools"
```

---

## Task 8: Core index exports + main entry

**Files:**
- Create: `src/core/index.ts`
- Modify: `src/index.ts`
- Test: none (compile-only, covered by `npm run build` + existing tests importing core)

**Interfaces:**
- Consumes: Tasks 1–7 exports
- Produces: `src/core/index.ts` re-exports; `src/index.ts` adds core exports

- [ ] **Step 1: Create `src/core/index.ts`**

```ts
export type { CoreEvent } from './events.ts';
export { EventBus } from './events.ts';
export { Session } from './session.ts';
export type { SkillInfo, SkillFrontmatter } from './skills/types.ts';
export { SkillRegistry, parseSkillDir } from './skills/registry.ts';
export { createSkillTool } from './skills/skill-tool.ts';
export { buildSystemPrompt } from './system-prompt.ts';
export { DaedalusEngine } from './engine.ts';
export type { EngineOptions } from './engine.ts';
```

- [ ] **Step 2: Update `src/index.ts`**

```ts
export { createAiClient } from './ai/index.ts';
export type { AiClient, StreamEvent, Message, ContentBlock, ToolDefinition, ChatParams } from './ai/types.ts';
export { AiError } from './ai/errors.ts';
export type { AiErrorKind } from './ai/errors.ts';
export { runAgent } from './agent/loop.ts';
export type { RunAgentParams } from './agent/loop.ts';
export { tools } from './tools/registry.ts';
export type { Tool, ToolContext, ToolResult } from './tools/types.ts';
export { loadConfig } from './config/config.ts';
export type { DaedalusConfig } from './config/config.ts';
// core
export { DaedalusEngine } from './core/engine.ts';
export type { EngineOptions } from './core/engine.ts';
export type { CoreEvent } from './core/events.ts';
export { EventBus } from './core/events.ts';
export { Session } from './core/session.ts';
export { SkillRegistry, parseSkillDir } from './core/skills/registry.ts';
export type { SkillInfo, SkillFrontmatter } from './core/skills/types.ts';
export { createSkillTool } from './core/skills/skill-tool.ts';
export { buildSystemPrompt } from './core/system-prompt.ts';
```

- [ ] **Step 3: Verify build + existing tests pass**

Run: `npm run build && npm test`
Expected: build succeeds, all tests pass

- [ ] **Step 4: Commit**

```bash
git add src/core/index.ts src/index.ts
git commit -m "feat: export core library surface"
```

---

## Task 9: Wire CLI to the engine (REPL commands + render)

**Files:**
- Modify: `src/cli/main.ts`
- Modify: `src/cli/repl.ts`
- Modify: `src/cli/render.ts`
- Test: `tests/cli/repl.test.ts` (new)

**Interfaces:**
- Consumes: `DaedalusEngine` from `src/core/engine.ts`, `CoreEvent` from `src/core/events.ts`, `SkillInfo` from `src/core/skills/types.ts`
- Produces:
  - `interface EngineLike { subscribe(h: (ev: CoreEvent) => void): () => void; run(prompt: string): Promise<string>; skills: SkillInfo[]; loadSkill(name: string): Promise<SkillInfo>; }` in `src/cli/repl.ts`
  - `type ReplLineResult = 'exit' | 'handled' | 'unhandled'`
  - `handleReplLine(line: string, engine: EngineLike): Promise<ReplLineResult>` (exported for test)
  - `runRepl(engine: EngineLike): Promise<void>`

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleReplLine } from '../../src/cli/repl.ts';
import type { SkillInfo } from '../../src/core/skills/types.ts';
import type { CoreEvent } from '../../src/core/events.ts';

class FakeEngine {
  calls: string[] = [];
  skills: SkillInfo[] = [{ name: 'review', description: 'Review code', body: 'Body', userInvocable: true }];
  async run(prompt: string): Promise<string> {
    this.calls.push(`run:${prompt}`);
    return 'done';
  }
  async loadSkill(name: string): Promise<SkillInfo> {
    this.calls.push(`load:${name}`);
    return { name, description: 'x', body: 'Body', userInvocable: true };
  }
  subscribe(_h: (ev: CoreEvent) => void): () => void { return () => {}; }
}

test('/exit returns exit', async () => {
  const engine = new FakeEngine();
  assert.equal(await handleReplLine('/exit', engine), 'exit');
});

test('/skills lists skills', async () => {
  const engine = new FakeEngine();
  assert.equal(await handleReplLine('/skills', engine), 'handled');
  assert.ok(engine.calls.length === 0);
});

test('/skill-name calls loadSkill and returns handled', async () => {
  const engine = new FakeEngine();
  assert.equal(await handleReplLine('/review', engine), 'handled');
  assert.deepEqual(engine.calls, ['load:review']);
});

test('unknown /command returns handled but no crash', async () => {
  const engine = new FakeEngine();
  assert.equal(await handleReplLine('/definitely-not-a-skill', engine), 'handled');
});

test('plain prompt returns unhandled', async () => {
  const engine = new FakeEngine();
  assert.equal(await handleReplLine('hello world', engine), 'unhandled');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/cli/repl.test.ts`
Expected: FAIL — module / `handleReplLine` not exported

- [ ] **Step 3: Rewrite `src/cli/repl.ts`**

```ts
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { ANSI } from './render.ts';
import type { SkillInfo } from '../core/skills/types.ts';
import type { CoreEvent } from '../core/events.ts';

export interface EngineLike {
  subscribe(handler: (ev: CoreEvent) => void): () => void;
  run(prompt: string): Promise<string>;
  skills: SkillInfo[];
  loadSkill(name: string): Promise<SkillInfo>;
}

export type ReplLineResult = 'exit' | 'handled' | 'unhandled';

const RESERVED = new Set(['exit', 'quit', 'help', 'skills', 'run']);

/** Handle one line of REPL input as a command. Returns how it was handled. */
export async function handleReplLine(line: string, engine: EngineLike): Promise<ReplLineResult> {
  const trimmed = line.trim();
  if (trimmed === '/exit' || trimmed === '/quit') return 'exit';
  if (trimmed === '/help') {
    console.log('Commands: /help, /exit, /skills, /<skill-name>. Type a prompt; blank line submits multi-line input.');
    return 'handled';
  }
  if (trimmed === '/skills') {
    for (const s of engine.skills) {
      console.log(`${ANSI.bold}${s.name}${ANSI.reset}${s.userInvocable ? '' : ' (user-only)'}: ${s.description}`);
    }
    if (engine.skills.length === 0) console.log('No skills installed.');
    return 'handled';
  }
  if (trimmed.startsWith('/') && !trimmed.includes(' ') && !RESERVED.has(trimmed.slice(1))) {
    const name = trimmed.slice(1);
    try {
      const info = await engine.loadSkill(name);
      console.log(`${ANSI.green}Loaded skill ${info.name}:${ANSI.reset} ${info.description}`);
    } catch {
      console.error(`${ANSI.red}Unknown skill: ${name}${ANSI.reset}`);
    }
    return 'handled';
  }
  return 'unhandled';
}

export async function runRepl(engine: EngineLike): Promise<void> {
  const rl = readline.createInterface({ input, output, prompt: `${ANSI.green}›${ANSI.reset} ` });
  rl.prompt();
  let buffer = '';
  for await (const line of rl) {
    const result = await handleReplLine(line, engine);
    if (result === 'exit') break;
    if (result === 'handled') { rl.prompt(); continue; }
    const trimmed = line.trim();
    if (trimmed === '/run' || buffer) {
      const prompt = buffer ? `${buffer}\n${trimmed === '/run' ? '' : trimmed}` : trimmed;
      buffer = '';
      console.log(ANSI.blue + '— running —' + ANSI.reset);
      try {
        const text = await engine.run(prompt);
        console.log(ANSI.dim + text + ANSI.reset);
      } catch (e) {
        console.error(ANSI.red + `error: ${(e as Error).message}` + ANSI.reset);
      }
      console.log();
      rl.prompt();
      continue;
    }
    buffer = trimmed;
    rl.prompt();
  }
  rl.close();
}
```

> **Behavior note:** `/skill-name` calls `engine.loadSkill(name)`, which marks the skill loaded and injects its body as a user message into history. The skill's instructions become active for the **next** `engine.run(prompt)` (and remain for the session). It does not auto-run a separate agent loop — matching the approved spec (2.4 user invocation: "marks loaded + injects body as a user message in history").

- [ ] **Step 4: Rewrite `src/cli/render.ts`**

```ts
import type { CoreEvent } from '../core/events.ts';

export const ANSI = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', red: '\x1b[31m',
  green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m', gray: '\x1b[90m', italic: '\x1b[3m',
} as const;

export function renderText(text: string, style: keyof typeof ANSI): string {
  return `${ANSI[style]}${text}${ANSI.reset}`;
}

export function renderEvent(ev: CoreEvent): void {
  switch (ev.type) {
    case 'text_delta': process.stdout.write(ev.text); break;
    case 'thinking_delta': process.stdout.write(`${ANSI.dim}${ANSI.italic}${ev.thinking}${ANSI.reset}`); break;
    case 'tool_call_start': process.stdout.write(`\n${renderText(`▶ ${ev.name}`, 'gray')} `); break;
    case 'tool_call_delta': process.stdout.write(ev.inputDelta); break;
    case 'skill_load': process.stdout.write(`\n${renderText(`[skill] ${ev.name} loaded`, 'green')}\n`); break;
    case 'done': process.stdout.write('\n'); break;
    case 'error': process.stdout.write(`\n${renderText(`[error] ${ev.error.message}`, 'red')}\n`); break;
    case 'session_start': break;
    case 'session_end': break;
  }
}
```

> **Note:** `renderEvent` now consumes `CoreEvent` (which supersets `StreamEvent`). It is passed to `engine.subscribe(renderEvent)` — the type now lines up exactly.

- [ ] **Step 5: Rewrite `src/cli/main.ts`**

```ts
#!/usr/bin/env node
import readline from 'node:readline/promises';
import { loadConfig } from '../config/config.ts';
import { createAiClient } from '../ai/index.ts';
import { DaedalusEngine } from '../core/engine.ts';
import { runRepl } from './repl.ts';
import { ANSI, renderEvent } from './render.ts';

function parseFlags(argv: string[]) {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--provider') flags.provider = argv[++i];
    else if (a === '--model') flags.model = argv[++i];
    else if (a === '--base-url') flags.baseUrl = argv[++i];
    else if (a === '--help') flags.help = '1';
  }
  return flags;
}

const flags = parseFlags(process.argv.slice(2));
if (flags.help) {
  console.log('daedalus — a terminal agent\n\nUsage: daedalus [--provider openai|anthropic] [--model M] [--base-url URL]\n\nConfig: ~/.daedalus/config.json and DAEDALUS_* env vars.');
  process.exit(0);
}

const base = loadConfig();
const config = {
  provider: (flags.provider ?? base.provider) as 'openai' | 'anthropic',
  apiKey: base.apiKey,
  baseURL: flags.baseUrl ?? base.baseURL,
  model: flags.model ?? base.model,
};
const client = createAiClient(config);
const askPermission = async (action: string, target: string): Promise<boolean> => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${ANSI.yellow}Allow ${action}? ${target} [y/n] ${ANSI.reset}`)).trim().toLowerCase();
  rl.close();
  return answer === 'y' || answer === 'yes';
};

console.log(`${ANSI.bold}Daedalus${ANSI.reset} — agent ready (${config.provider}${config.model ? ` / ${config.model}` : ''})`);
const engine = new DaedalusEngine({
  client,
  cwd: process.cwd(),
  askPermission,
});
engine.subscribe(renderEvent);
await runRepl({ engine } as never); // runRepl now takes (engine), not ({ engine })
engine.dispose();
```

> **Note:** `runRepl` signature is `(engine: EngineLike)`. Call it as `await runRepl(engine)` — drop the `as never` wrapper and the object literal. The wrapper line above is a mistake to avoid.

- [ ] **Step 6: Run the full test suite + build**

Run: `npm test && npm run build`
Expected: all tests pass, build succeeds

- [ ] **Step 7: Commit**

```bash
git add src/cli/main.ts src/cli/repl.ts src/cli/render.ts tests/cli/repl.test.ts
git commit -m "feat: wire CLI to DaedalusEngine with /skill commands and skill_load rendering"
```

---

## Task 10: Cache-stability test

**Files:**
- Create: `tests/core/cache-stability.test.ts`

**Interfaces:**
- Consumes: `DaedalusEngine` (Task 7)

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DaedalusEngine } from '../../src/core/engine.ts';
import type { AiClient } from '../../src/ai/types.ts';

test('message prefix stays stable across plain runs (no skill loads)', async () => {
  const snapshots: string[] = [];
  const engine = new DaedalusEngine({
    client: {
      async *streamChat(params) {
        snapshots.push(JSON.stringify(params.messages));
        yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } };
      },
    },
    cwd: process.cwd(),
    askPermission: async () => true,
    skillDirs: [],
    maxIterations: 2,
  });
  await engine.run('first');
  await engine.run('second');
  await engine.run('third');
  assert.equal(snapshots.length, 3);
  // Each request is a strict superset of the previous (append-only history).
  assert.ok(snapshots[1].length > snapshots[0].length);
  assert.ok(snapshots[2].length > snapshots[1].length);
  engine.dispose();
});

test('skill load only appends, never mutates earlier messages', async () => {
  const base = join(tmpdir(), `dae-cache-${Date.now()}`);
  mkdirSync(join(base, 'review'), { recursive: true });
  writeFileSync(join(base, 'review', 'SKILL.md'), '---\nname: review\ndescription: Review\n---\nBody text');
  const before: string[] = [];
  let call = 0;
  const engine = new DaedalusEngine({
    client: {
      async *streamChat(params) {
        before.push(JSON.stringify(params.messages));
        call++;
        if (call === 1) {
          yield { type: 'done', message: { role: 'assistant', content: [{ type: 'tool_call', id: 's1', name: 'Skill', input: { name: 'review' } }] } };
        } else {
          yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } };
        }
      },
    },
    cwd: process.cwd(),
    askPermission: async () => true,
    skillDirs: [base],
    maxIterations: 4,
  });
  await engine.run('use review');
  assert.equal(before.length, 2);
  // The skill body reaches messages via the Skill tool's tool_result (appended), and the
  // earlier messages (system-assembly + user prompt) are byte-identical between calls.
  assert.ok(before[0].startsWith('[') && before[0].endsWith(']'));
  assert.ok(before[1].includes('Body text'));
  engine.dispose();
  rmSync(base, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/core/cache-stability.test.ts`
Expected: FAIL — module not found (engine not built yet at this task order, or prefix-mutation bug)

- [ ] **Step 3: Run test to verify it passes**

Run: `node --test tests/core/cache-stability.test.ts`
Expected: PASS — loop only appends; prefix byte-identical; skill body present in 2nd call

- [ ] **Step 4: Commit**

```bash
git add tests/core/cache-stability.test.ts
git commit -m "test: assert cache-stable message prefix across runs and skill loads"
```

---

## Task 11: README update

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update README**

Add a "Skills" section documenting:
- Skill format (`SKILL.md` with `name`/`description` frontmatter + body)
- Locations: project `.claude/skills/` (highest precedence, walks parents to repo root), user `~/.daedalus/skills/`
- Model invocation via the `Skill` tool (body loads on demand as a tool_result); user invocation via `/skill-name` and `/skills`
- Note: `allowed-tools`/`disallowed-tools` are parsed but not yet enforced (deferred to the MCP sub-project)
- Note: sessions are persistent across inputs within a process

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: document skills and sessions in README"
```

---

## Self-Review

**Spec coverage:**
- 2.2 DaedalusEngine facade → Task 7
- 2.3 Session lifecycle → Task 2
- 2.4 Skills format/discovery/listing → Task 3
- 2.4 Skill tool + invocation contract (tool_result body, dedup, unknown-name error) → Task 4
- 2.4 User invocation `/skill-name`, `/skills` → Task 9
- System prompt in core → Task 5 + Task 9 (main.ts no longer passes a system prompt)
- 3.1 Event types incl. `skill_load` → Task 1
- 3.2 Data flow → Task 6 + Task 9
- 4. Prompt caching (stable prefix, skill bodies as user messages) → Task 10
- 5. Error handling (unknown skill, malformed frontmatter, unreadable dir) → Task 3 (parse returns null), Task 4 (error result), Task 9 (CLI error)
- 6. Testing matrix → Tasks 1–10
- 7. Scope deferrals → respected (MCP, tool filtering, `context: fork`, `$ARGUMENTS` all deferred)

**Placeholder scan:** No TBD/TODO. Task 3's inline name-fallback expression is flagged with a clear instruction to use `basename(dir)`. Task 9 Step 5 has a `as never` wrapper explicitly flagged as a mistake to avoid (the implementer must call `runRepl(engine)` directly) — this is an intentional guard, not a silent placeholder. No other gaps.

**Type consistency:**
- `CoreEvent` defined Task 1, used Task 2/6/7/9 ✓
- `SkillInfo` defined Task 3, used Task 4/7/9 ✓
- `SkillRegistry(skillDirs?: string[])` Task 3, called Task 7 (`new SkillRegistry(opts.skillDirs)`) ✓
- `createSkillTool(registry, session)` Task 4, called Task 7 ✓
- `runAgent` final signature includes `cwd`/`askPermission` (Task 6), called by engine (Task 7) with both ✓
- `renderEvent(ev: CoreEvent)` Task 9, matched to `engine.subscribe` handler type ✓
- `runRepl(engine: EngineLike)` Task 9, called from `main.ts` as `runRepl(engine)` ✓
- `loadSkill(name): Promise<SkillInfo>` Task 7 (marks loaded + injects body), consumed by Task 9 `/skill-name` ✓

**Known follow-up:** `session_start`/`session_end` events are emitted but not visually consumed by the REPL yet — the web panel will use them. The REPL multi-line `/run` flow is unchanged in behavior.
