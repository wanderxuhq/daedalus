# Daedalus

Daedalus is a terminal agent in the spirit of Claude Code: you talk to it in a REPL and it can read, write, and edit files, list and search the filesystem, and run shell commands to get things done.

Under the hood it uses a **unified AI IR layer** (`src/ai/`) so the agent loop, tools, and CLI never talk to a provider's wire format directly. Both **Anthropic** and **OpenAI** are supported out of the box, and switching providers is a configuration change — not a code change.

Key properties:

- **Zero runtime dependencies.** Everything is Node built-ins (`fetch`, `node:fs`, `node:child_process`) plus a hand-written SSE parser. No AI SDKs, no `node-gyp`.
- **Prompt-cache friendly.** The agent loop keeps the request prefix stable (`system → tools → history → new turn`) and the Anthropic adapter marks stable segments with `cache_control`.
- **Streaming.** Token and tool-call output is streamed from the provider and rendered as it completes (deltas arrive in a burst at the end of each response turn).
- **Minimal permission baseline.** Shell commands ask for `y/n` confirmation before running — unless you opt into auto-approve mode (`--auto`).

## Install

### From the repository (local)

```bash
git clone <your-daedalus-repo>
cd daedalus
npm install        # dev dependencies only (typescript, @types/node)
npm run build      # compile src/ -> dist/
npm i -g .         # install the `daedalus` binary globally
```

The `bin` entry (`dist/cli/main.js`) is produced by `tsc`, so a build is required before a fresh checkout can be installed.

### Published package

```bash
npx daedalus
```

## Configuration

Daedalus reads configuration in the following order (later sources win):

1. Built-in defaults
2. `~/.daedalus/config.json` (optional)
3. Environment variables (`DAEDALUS_*`)

### Config file

Create `~/.daedalus/config.json`:

```json
{
  "provider": "anthropic",
  "apiKey": "sk-ant-...",
  "model": "claude-sonnet-4-5",
  "baseURL": "https://api.anthropic.com",
  "maxContextTokens": 100000,
  "autoApprove": false
}
```

All fields are optional. `autoApprove` (default `false`) answers every tool permission prompt (shell commands, file overwrites) without asking — see [Auto-approve mode](#auto-approve-mode). `thinking` (default `true`) enables extended thinking — the model's chain-of-thought is requested on every turn and rendered as dim italic text. Set `"thinking": false` to disable. For OpenAI:

```json
{
  "provider": "openai",
  "apiKey": "sk-...",
  "model": "gpt-4o",
  "baseURL": "https://api.openai.com/v1"
}
```

`baseURL` lets you point at any OpenAI-compatible endpoint (e.g. Ollama, DeepSeek, vLLM). If `provider` is omitted it defaults to `anthropic`; if `model` is omitted it defaults to the provider's default (`claude-sonnet-4-5` for Anthropic, `gpt-4o` for OpenAI).

### Environment variables

Daedalus-specific variables:

| Variable | Purpose |
|---|---|
| `DAEDALUS_PROVIDER` | Provider name: `openai` or `anthropic` (overrides config file / default) |
| `DAEDALUS_API_KEY` | API key for any provider (highest priority) |
| `DAEDALUS_MODEL` | Model name (overrides config file) |
| `DAEDALUS_BASE_URL` | Provider base URL (overrides config file) |
| `DAEDALUS_MAX_CONTEXT_TOKENS` | Context budget in tokens (overrides config file; default 100,000) |
| `DAEDALUS_AUTO_APPROVE` | Auto-approve tool permissions (any value except `0`/`false`/empty; overrides config file, `--auto` overrides this) |
| `DAEDALUS_THINKING` | Extended thinking on by default; set `0`/`false` to disable (overrides config file) |
| `DAEDALUS_THINKING_BUDGET` | Thinking budget in tokens (Anthropic) / reasoning effort (OpenAI-compatible) |
| `DAEDALUS_SESSIONS_DIR` | Directory for persisted sessions (default `~/.daedalus/sessions`) |

Standard provider keys are also honored when `DAEDALUS_API_KEY` is not set:

- `ANTHROPIC_API_KEY` — used when the active provider is `anthropic`
- `OPENAI_API_KEY` — used when the active provider is `openai`

If no key can be found for the active provider, Daedalus starts an interactive first-run setup wizard that asks for a base URL, API key and model, and writes them to `~/.daedalus/config.json` for you. The provider is derived from the base URL: a URL that names a provider (anthropic/openai) is taken at face value, and an ambiguous URL (a proxy, local endpoint, or gateway) is confirmed with an API-format question before the provider is recorded. Press Ctrl-C or leave the key blank to skip the wizard and set the env vars yourself.

## Usage

```bash
daedalus [--provider openai|anthropic] [--model M] [--base-url URL] [--resume [id]] [--auto] [--help]
```

| Flag | Description |
|---|---|
| `--provider openai\|anthropic` | Override the active provider |
| `--model M` | Override the model |
| `--base-url URL` | Override the provider base URL |
| `--resume [id]` | Continue a session (no id = the latest); see Sessions & context |
| `--auto` | Auto-approve tool permissions (no `y/n` prompts); see below |
| `--help` | Print usage and exit |

### Auto-approve mode

By default the agent pauses and asks `y/n` before running a shell command or overwriting an existing file. Auto-approve mode answers yes to every permission prompt, so the agent can work unattended:

```bash
daedalus --auto
```

You can also enable it persistently with the `autoApprove` config-file field or the `DAEDALUS_AUTO_APPROVE` environment variable (any value except `0`, `false`, or empty). Precedence: `--auto` > `DAEDALUS_AUTO_APPROVE` > config file.

> **⚠️ Safety.** Auto-approve runs every `bash` command and every file overwrite with no review step between the model's decision and the side effect. Only use it in environments you trust, with a model you trust. In particular, do not enable it where the agent can reach credentials, git remotes, or destructive commands (`rm`, `git push --force`, `DROP TABLE`) that you would not want executed automatically.

### REPL commands

Once started you land in the REPL prompt (`›`):

| Command | Action |
|---|---|
| `/exit`, `/quit` | Leave the REPL |
| `/help` | Print available commands |
| `/skills` | List installed skills |
| `/sessions` | List saved sessions (newest first) |
| `/resume [id]` | Continue a saved session in place (no id = the latest) |
| `/cost` | Print this session's cumulative token usage |
| `/undo` | Restore the most recent file edit/write (in-memory, per-session) |
| `/clear` | Drop the conversation history (system prompt kept) |
| `/compact` | Manually summarize the oldest turns to fit the context budget |
| `/model [name]` | Show or set the session's model override |
| `/init` | Create `<cwd>/DAEDALUS.md` (never overwrites an existing one) |
| `/permissions [auto\|ask]` | Show or toggle auto-approve for this session |
| `/plan` | Read-only mode: write/edit disabled everywhere (even for subagents); a run exits it |
| `/<skill-name>` | Load a skill (e.g. `/review`) into the current session |

Any other input is a prompt for the agent — a prompt submits on the first Enter. For multi-line input, press **Ctrl+Enter** (or, on terminals that distinguish it, **Shift+Enter**) to continue the prompt onto the next line, or end a line with `\` to do the same; then submit with `/run` (or an empty line). The agent runs, streams its response and tool calls, executes tools (asking `y/n` before shell commands unless auto-approve is on), and reports the result.

## Tools

Ten built-in tools are registered (see `src/tools/registry.ts`); the engine adds the `Skill` tool (see [Skills](#skills)), the `delegate` tool, and `delegateMany` (see [Multi-agent](#multi-agent)). By default the main agent calls `read`/`write`/`edit`/`Skill`/`delegate`/`consult` directly, while `bash`/`ls`/`grep`/`glob`/`shell`/`diff` are delegated tools — available only to subagents, which keeps exploration and command output out of the main context:

| Tool | Description | Used by |
|---|---|---|
| `bash` | Execute a shell command and return its output. Asks permission first (auto-approved in `--auto` mode); 2-minute timeout. | subagent (via `delegate`) |
| `shell` | Execute a shell command with streaming output. | subagent (via `delegate`) |
| `read` | Read a file, optionally with a line `offset`/`limit`. Refuses to read files over 1 MB whole (pass `offset`/`limit` instead); partial reads are line-numbered. | main agent + subagent |
| `write` | Write content to a file. Asks permission before overwriting an existing file (auto-approved in `--auto` mode); creates parent directories automatically. | main agent + subagent |
| `edit` | Replace an exact string in a file. Errors if the string is not found or matches more than once. | main agent + subagent |
| `ls` | List directory contents; skips `node_modules` and `.git`. | subagent (via `delegate`) |
| `grep` | Recursively search file contents for a regex pattern; skips `node_modules` and `.git`. | subagent (via `delegate`) |
| `glob` | Find files matching a glob pattern (`*`, `**`, `?`); skips `node_modules` and `.git`. | subagent (via `delegate`) |
| `diff` | Compute a unified diff between two files or strings. | subagent (via `delegate`) |
| `Skill` | Load a skill by name; the skill body arrives as the tool result. Provided by the engine; see Skills. | main agent |
| `delegate` | Run a self-contained task in a separate subagent with its own isolated context; returns only the subagent's final report. Supports `background: true` for async execution. Provided by the engine; see Multi-agent. | main agent |
| `consult` | Consult another AI model for a second opinion without leaving the session. | main agent |

## Skills

Skills are reusable instruction packs the model can load on demand. A skill is a directory containing a `SKILL.md` file:

```markdown
---
name: review
description: Review code for correctness and style
---

Review the codebase for bugs and style issues.
```

The frontmatter supports `name`, `description`, `when_to_use`, `allowed-tools`, `disallowed-tools`, `disable-model-invocation`, and `user-invocable`; the rest of the file is the skill body. If `name` is omitted, it falls back to the directory name.

Skills are discovered from two locations, in order (the first match for a given name wins):

1. **Project skills** — every `.claude/skills/` directory from the working directory up to the filesystem root (nearest wins).
2. **User skills** — `~/.daedalus/skills/`.

The model can load a skill through the `Skill` tool: it picks a name from the tool's listing and the body arrives in the conversation as a tool result. You can also load one yourself from the REPL with `/<skill-name>` (see the REPL commands above).

`allowed-tools` and `disallowed-tools` are parsed but not yet enforced — per-tool restriction is deferred to the MCP sub-project. Sessions are persistent across inputs within a process, so a loaded skill stays active for subsequent turns.

## Multi-agent

Daedalus implements an orchestrator/worker pattern: the main agent can hand a large or self-contained task to a **subagent** via the `delegate` tool, or fan out several independent tasks to parallel subagents with `delegateMany`, instead of doing them inline.

**Tool layering by default.** The main agent is deliberately *not* given the full toolset — it holds the author's loop (`read`, `write`, `edit`, `Skill`) plus `delegate` and `delegateMany`. `bash`, `ls`, `grep`, and `glob` exist **only** in the subagent's toolset, so exploration, search, and command execution are forced through subagents: the main agent plans and edits, subagents explore and execute. The system prompt spells this out ("you are the author, subagents do the exploration") and tells the model that reaching for a delegated tool is the signal to delegate. To restore self-service exploration, construct the engine with `mainAgentTools` set to the full list (see `src/core/engine.ts`).

```jsonc
{
  "task": "Add unit tests for the glob matcher to tests/tools/glob.test.ts",
  "context": "The matcher lives in src/tools/glob.ts. Follow the existing test style in tests/tools/*.test.ts.",
  "tools": ["read", "grep", "write", "bash"], // optional restriction, default: all built-in
  "maxIterations": 30, // optional cap on subagent tool-call iterations
  "maxResultChars": 20000, // optional cap on the returned report (default 20000)
  "agent": "glob-tests", // optional named identity: continues this subagent's history across calls
  "json": true, // optional: ask for the report as a single valid JSON value
  "retries": 1 // optional: retry the whole run this many times after a failure
}
```

`delegateMany` takes a `tasks` array of the same shape plus a `maxConcurrent` cap (default 3), and merges the per-subagent reports into one result. It degrades gracefully: a failed lane is marked `(failed)` in the merged report and the call errors only when *every* lane fails — partial results are still returned.

Design properties:

- **Context isolation.** Each subagent gets its own session — its own system prompt and your task/context text. It cannot see the main conversation, and its tool calls and intermediate steps never enter the main session. Only its final report returns, as one `tool_result` to the main agent. This is what keeps the main context clean on long jobs.
- **Depth cap, not tool absence.** By default a subagent is given only the built-in tools and cannot delegate further. With `delegateMaxDepth: 2` on the engine, a subagent may spawn its own subagents (which then cannot), and so on — the configured depth cap is the recursion guard.
- **Working memory (optional).** With the engine's session pool, passing the same `agent` name across `delegate` calls continues that subagent's previous history, so a long investigation can pick up where it left off instead of starting cold each time.
- **Independent budget.** Each subagent's history is trimmed against its own `maxContextTokens`, untouched by trims in the main session.
- **Failure is a tool error.** If a subagent fails (provider error, iteration cap), the call returns an error result the main agent can see and adapt to — it does not crash the main turn. Optional `retries` re-runs a failed subagent before degrading. Ctrl+C interrupts propagate to subagents and are treated as interrupts, not as failures.
- **Same permission gate.** Subagent `bash`/`write` calls go through the same `y/n` permission prompt as the main agent (or auto-approve in `--auto` mode).

Reports longer than 20,000 characters are truncated (configurable per call via `maxResultChars`). Subagent progress (task start, tool calls, text) is forwarded onto the main session's event bus for the REPL UI and `/cost` accounting — it never enters the main conversation.

## Sessions & context

Every conversation is a **session**. Daedalus auto-saves the current session after each completed turn (`run()`) and when it shuts down (`dispose()`), writing it to `~/.daedalus/sessions/<id>.json` (override the directory with `DAEDALUS_SESSIONS_DIR`). One session maps to one file: the id is generated on the first save and reused across runs, and `--resume` keeps writing to the same file.

To pick up where you left off, start Daedalus with `--resume` to continue the most recent session, or `--resume <id>` for a specific one:

```bash
daedalus --resume                        # continue the latest session
daedalus --resume 2026-08-09T23-15-07    # continue a specific session
```

The persisted system prompt is reused verbatim on resume, so the prompt-cache prefix stays byte-identical across restarts.

You can also switch sessions from inside the REPL without restarting: `/sessions` lists saved sessions (newest first), and `/resume [id]` swaps the live session for a saved one in place — the current session is saved first so nothing is lost, and subsequent turns keep writing to the resumed session's file:

```
› /sessions
2026-08-09T23-15-07  5 messages  updated 2026-08-09T23:16:01
2026-08-09T22-10-00  3 messages  updated 2026-08-09T22:12:00
Continue one with /resume <id> (no id = the latest).
› /resume 2026-08-09T22-10-00
resumed session 2026-08-09T22-10-00 (3 messages)
```

### Context budget

History is trimmed at whole-turn boundaries when the estimated token count exceeds the context budget (`maxContextTokens`, default 100,000). The budget comes from the `DAEDALUS_MAX_CONTEXT_TOKENS` environment variable, the `maxContextTokens` config-file field, or the built-in default. A trim cuts to roughly half the budget so trims stay rare and cache misses infrequent. Skill bodies are never trimmed while the skill stays loaded. When a trim happens, Daedalus prints a `— context trimmed: N messages kept —` line.

Deferred (see the design spec): model-driven summarization and exact token counting.

## Roadmap

This is a first vertical slice. Deferred items — a full permissions system (rules, allow/deny/ask, per-project settings), deeper configuration, a richer TUI, more tools (WebFetch/WebSearch), and more provider adapters — are tracked in the design spec:

[`docs/superpowers/specs/2026-08-09-daedalus-agent-design.md`](docs/superpowers/specs/2026-08-09-daedalus-agent-design.md)

## Dependency policy

- **No `node-gyp`, ever.** Any package that would pull in `node-gyp` (directly or transitively) is refused.
- **Zero runtime dependencies.** The runtime uses Node built-ins (`fetch`, `node:fs`, `node:child_process`, `node:readline`) and a hand-written SSE parser — no AI SDKs, no HTTP client libraries.
- Development/build-time dependencies are limited to `typescript` and `@types/node`.

## Development

Requires **Node >= 24** (used for native TypeScript type-stripping — no build step during development).

```bash
npm test          # run the node:test suite (tests/**/*.test.ts)
npm run build     # tsc compile src/ -> dist/ (for publishing / global install)
npm run dev       # run the CLI directly from source: node src/cli/main.ts
```

Project conventions (see the plan in `.superpowers/sdd/`):

- ESM (`"type": "module"`); all relative imports use an explicit `.ts` extension.
- No `enum`, no `namespace`, no constructor parameter properties (required for Node's type-stripping).
- Tests use `node:test`, zero test dependencies.

Daedalus also exposes a small library API from `src/index.ts` (`createAiClient`, `runAgent`, `tools`, `loadConfig`, `AiError`, and the IR types) for embedding in other tools.

## Web UI

`daedalus web [--port 3100]` starts a standalone web UI (mobile-first, desktop-parity).

- Open http://localhost:3100 (or the printed LAN URL) in a browser.
- Main chat with streaming, thinking, tool cards, inline permission cards (ask ↔ auto toggle).
- Subagents panel (drawer on narrow screens) → click an agent for its detail view.
- `#/sessions` for session management (continue / rename / delete / new).
- Sessions share `~/.daedalus/sessions` with the CLI — they interoperate.
- i18n: English (default) and 简体中文, auto-detected from browser language, persisted in localStorage.

