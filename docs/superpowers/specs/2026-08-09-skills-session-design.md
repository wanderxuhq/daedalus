# Daedalus Skills + Session Architecture Design

Date: 2026-08-09
Status: Approved (brainstorming)

## 1. Context and Goals

Daedalus is a terminal agent (similar to Claude Code) with a zero-runtime-dependency
core (`ai/`, `tools/`, `config/`, `agent/`) and a thin CLI (`cli/`). This design adds:

1. **Skills** — Markdown instruction packs (Claude Code / Agent Skills format) that
   the agent can load on demand to guide behavior.
2. **Persistent sessions** — cross-input conversation state, which skills require
   (loaded skill content must persist across REPL inputs) and which prompt-caching
   optimization depends on.

### Non-Goals (this sub-project)

- **MCP support** — a separate sub-project, to be designed after this one lands.
- **Web panel** — a future UI; this design only ensures the core is UI-agnostic so a
  web panel can be built later without coupling.

### Constraints

- **No dependency that directly or indirectly requires node-gyp** (hard constraint,
  user-mandated). Any `npm install` must be approved by the user first. This design
  requires zero new runtime dependencies.
- **Prompt-caching maximization**: the system prompt prefix must stay stable; variable
  content (skill bodies, tool results) goes into conversation messages, never into the
  system prompt.
- **Core must not depend on the CLI/UI.** The CLI is one consumer of the core; a web
  panel must be able to import the same core without changes.

## 2. Architecture

### 2.1 Layering

```
┌─ src/core/ ──────────────────── UI-agnostic core (library)
│   ├─ engine.ts         ← DaedalusEngine: single facade, owns everything
│   ├─ session.ts        ← Session: MessageHistory + skill-loaded state
│   ├─ system-prompt.ts  ← system prompt assembly (in core)
│   └─ skills/           ← SkillRegistry: load/match/render
│
├─ src/ai/ · src/tools/ · src/config/  ← existing, essentially unchanged
│
└─ src/cli/ ─────────────── one consumer: new Engine() + subscribe()
```

- Core imports nothing from `src/cli/`. CLI imports core only.
- `src/index.ts` becomes the public surface of the core library (it already exists).

### 2.2 DaedalusEngine (facade)

`DaedalusEngine` is the single entry point. It owns:

- the `Session` (conversation state)
- the `SkillRegistry` (loaded skill metadata + bodies)
- the tool registry (existing `tools/registry.ts` output)
- the AI client and config

```ts
interface EngineOptions {
  client: AiClient;
  cwd: string;
  askPermission: (action: string, target: string) => Promise<boolean>;
  skillDirs?: string[];       // extra skill search dirs (default: .claude/skills + ~/.daedalus/skills)
  maxIterations?: number;
}

class DaedalusEngine {
  constructor(opts: EngineOptions);
  subscribe(handler: (ev: CoreEvent) => void): () => void;  // returns unsubscribe
  run(prompt: string): Promise<string>;                      // drives one user input through the agent loop
  get skills(): SkillInfo[];                                 // listing for UI (names + descriptions)
  loadSkill(name: string): Promise<SkillInfo>;               // explicit load (e.g. /skill-name)
  dispose(): void;
}
```

`engine.run()` is the only path the CLI uses for a user prompt. The agent loop runs
inside it, sharing the Session's history across calls.

### 2.3 Session (lifecycle)

`Session` is the persistent conversation state. It owns:

- `MessageHistory` (existing `agent/context.ts`, promoted to core) — the messages array
- `loadedSkills: Map<string, SkillInfo>` — which skills are loaded this session

`Session` lives for the lifetime of the `DaedalusEngine` (process/REPL session). Each
`engine.run(prompt)` appends the user prompt to history, runs the agent loop (which may
append assistant messages and tool results), and returns the final text.

Lifecycle events (`session_start`, `session_end`) mark the Session's boundaries so a UI
can render "session started" / reset state.

### 2.4 Skills

#### Format

A skill is a directory containing `SKILL.md`:

```
--- (YAML frontmatter)
name: code-review
description: Review code changes for correctness, security, and style.
when_to_use: When the user asks to review code or check a diff.
allowed-tools: []        # optional: restrict which tools this skill may use
disallowed-tools: []     # optional: deny specific tools
disable-model-invocation: true   # optional: user-only invocation
user-invocable: true             # default true
---
markdown body...
```

Minimum required frontmatter: `name`, `description`. Missing/empty frontmatter: the
skill still loads with empty metadata (body still usable via `/skill-name`), matching
Claude Code behavior.

#### Discovery (precedence)

1. Project: `.claude/skills/` in the starting directory and parent dirs up to repo root
2. User: `~/.daedalus/skills/`
3. Extra dirs via `engine` option `skillDirs`

Higher precedence wins on name collision. Plugin/namespaced skills are out of scope
(no plugin system yet).

#### Model-visible surface: a single `Skill` tool

Exactly one tool is added to the model's tool list: `Skill`.

- name: `Skill`
- description: "Load a skill by name. Skills provide instructions/context that guide
  the conversation. Available skills: <name — desc> for each loaded skill."
- input schema: `{ name: string }`

At session start, only the skill **listing** (name + description, subject to a context
budget) is present — in the `Skill` tool's description. Full bodies load on demand.

#### Invocation contract

When the model calls `Skill(name="code-review")`:

1. Validate against the registry; if unknown, return an error tool_result.
2. Render the body: apply `$ARGUMENTS` substitution (currently empty — no arg passing
   in v1) and `` `!command`` `` dynamic context (deferred to v1.1; body is static in v1).
3. Return a **single tool_result** whose content is the rendered SKILL.md body
   (role `user`, paired with the assistant `tool_call`).
4. Mark the skill as loaded in the Session (`loadedSkills`).
5. If already loaded with identical content, return a short "already loaded" note
   instead of re-injecting (dedup).

The full body is carried by the tool_result and persists in history for the session —
this is the "enters the conversation as a single message" behavior, cache-safe (it sits
in the conversation layer below the system-prompt cache breakpoint).

#### Tool filtering (allowed-tools / disallowed-tools)

Not implemented in v1. Skills in v1 are pure-instruction. The frontmatter fields are
parsed but ignored, with a note in the skill listing rendering. Dynamic tool
registration/filtering is deferred to the MCP sub-project, where it belongs.

#### User invocation

- `/skill-name` in the REPL → `engine.loadSkill(name)` → marks loaded + injects body as
  a user message in history (same content path as the `Skill` tool, but initiated by the
  user, not the model).
- `/skills` lists user-invocable skills (name + description + user-invocable flag).

## 3. Event Stream

### 3.1 Core event types

```ts
type CoreEvent =
  | { type: 'session_start' }
  | { type: 'session_end' }
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'tool_call_start'; id: string; name: string }
  | { type: 'tool_call_delta'; id: string; inputDelta: string }
  | { type: 'skill_load'; name: string }         // NEW: skill loaded (status change)
  | { type: 'done'; message: Message }
  | { type: 'error'; error: AiError };
```

The existing `StreamEvent` type (`ai/types.ts`) is reused/extended. `skill_load` is a
status event for the UI; it does NOT go into messages. The skill body itself goes into
messages via the `Skill` tool's tool_result.

### 3.2 Data flow

```
user prompt
  → engine.run(prompt)
      → Session appends user message to history
      → agent loop: streamChat(messages, tools=[...builtin, Skill], cache)
          → emits StreamEvent → forwarded as CoreEvent to subscribers
          → on Skill tool_call → skill loaded → tool_result carries body
          → next iteration continues with body in context
      → returns final text
```

## 4. Prompt Caching

- **Stable prefix**: system prompt (core-assembled, constant) + early conversation.
  No skill content ever enters the system prompt.
- **Skill bodies** are conversation user messages (via tool_result), below the
  breakpoint — loading a skill does not invalidate the prefix cache.
- `cache: { enabled: true }` stays as-is on `streamChat`.
- MCP deferred-loading optimization is out of scope here (MCP sub-project).

## 5. Error Handling

- Unknown skill name in `Skill` tool call → error tool_result (`Unknown skill: X`,
  `isError: true`), loop continues (model can retry or abandon).
- Malformed frontmatter → skill loads with empty metadata; `/skill-name` still works.
- Skill directory unreadable → skipped at registry load, warning logged.
- `engine.run` errors propagate to caller (CLI catches and renders); `error` CoreEvent
  emitted for UI.

## 6. Testing

- **SkillRegistry**: discovery precedence, frontmatter parsing (valid/malformed/missing),
  listing rendering, unknown-name handling.
- **Skill tool contract**: model `Skill(name)` call → tool_result carries body; dedup on
  re-invoke; unknown name → error result.
- **Session**: cross-`run` persistence (messages accumulate, loaded skills persist),
  lifecycle events order.
- **Engine**: facade wires client/tools/skills/session; `run` end-to-end with a fake
  AiClient; `subscribe` receives events in order.
- **CLI**: `/skill-name` and `/skills` command routing (unit-level, no full REPL loop).
- **Caching**: assert the messages array sent to the adapter is stable across
  non-loading turns (prefix unchanged when only assistant/user messages appended).
- Existing tests keep passing (45/45).

## 7. Scope Check / Deferred to MCP Sub-project

- MCP transports, `mcp__server__tool` naming, deferred tool search, schema flattening,
  auth — deferred.
- Dynamic tool registration/filtering (`allowed-tools`, per-skill tool sets) — deferred.
- `context: fork` (subagent), `$ARGUMENTS` passing, `` `!command`` dynamic context —
  deferred to v1.1.
- Plugin skills, namespacing, `skillOverrides` — deferred (no plugin system).
