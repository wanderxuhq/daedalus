# Daedalus

Daedalus is a terminal agent in the spirit of Claude Code: you talk to it in a REPL and it can read, write, and edit files, list and search the filesystem, and run shell commands to get things done.

Under the hood it uses a **unified AI IR layer** (`src/ai/`) so the agent loop, tools, and CLI never talk to a provider's wire format directly. Both **Anthropic** and **OpenAI** are supported out of the box, and switching providers is a configuration change — not a code change.

Key properties:

- **Zero runtime dependencies.** Everything is Node built-ins (`fetch`, `node:fs`, `node:child_process`) plus a hand-written SSE parser. No AI SDKs, no `node-gyp`.
- **Prompt-cache friendly.** The agent loop keeps the request prefix stable (`system → tools → history → new turn`) and the Anthropic adapter marks stable segments with `cache_control`.
- **Streaming.** Token and tool-call output is streamed from the provider and rendered as it completes (deltas arrive in a burst at the end of each response turn).
- **Minimal permission baseline.** Shell commands ask for `y/n` confirmation before running.

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
  "maxContextTokens": 100000
}
```

All fields are optional. For OpenAI:

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
| `DAEDALUS_SESSIONS_DIR` | Directory for persisted sessions (default `~/.daedalus/sessions`) |

Standard provider keys are also honored when `DAEDALUS_API_KEY` is not set:

- `ANTHROPIC_API_KEY` — used when the active provider is `anthropic`
- `OPENAI_API_KEY` — used when the active provider is `openai`

If no key can be found for the active provider, Daedalus starts an interactive first-run setup wizard that asks for a base URL, API key and model, and writes them to `~/.daedalus/config.json` for you. The provider is derived from the base URL: a URL that names a provider (anthropic/openai) is taken at face value, and an ambiguous URL (a proxy, local endpoint, or gateway) is confirmed with an API-format question before the provider is recorded. Press Ctrl-C or leave the key blank to skip the wizard and set the env vars yourself.

## Usage

```bash
daedalus [--provider openai|anthropic] [--model M] [--base-url URL] [--resume [id]] [--help]
```

| Flag | Description |
|---|---|
| `--provider openai\|anthropic` | Override the active provider |
| `--model M` | Override the model |
| `--base-url URL` | Override the provider base URL |
| `--resume [id]` | Continue a session (no id = the latest); see Sessions & context |
| `--help` | Print usage and exit |

### REPL commands

Once started you land in the REPL prompt (`›`):

| Command | Action |
|---|---|
| `/exit`, `/quit` | Leave the REPL |
| `/help` | Print available commands |
| `/skills` | List installed skills |
| `/<skill-name>` | Load a skill (e.g. `/review`) into the current session |

Any other input is a prompt for the agent — a prompt submits on the first Enter. For multi-line input, press **Ctrl+Enter** (or, on terminals that distinguish it, **Shift+Enter**) to continue the prompt onto the next line, or end a line with `\` to do the same; then submit with `/run` (or an empty line). The agent runs, streams its response and tool calls, executes tools (asking `y/n` before shell commands), and reports the result.

## Tools

Seven built-in tools are registered (see `src/tools/registry.ts`); the engine adds an eighth, the `Skill` tool (see [Skills](#skills)):

| Tool | Description |
|---|---|
| `bash` | Execute a shell command and return its output. Always asks permission first; 2-minute timeout. |
| `read` | Read a file, optionally with a line `offset`/`limit`. Refuses to read files over 1 MB whole (pass `offset`/`limit` instead); partial reads are line-numbered. |
| `write` | Write content to a file. Asks permission before overwriting an existing file; creates parent directories automatically. |
| `edit` | Replace an exact string in a file. Errors if the string is not found or matches more than once. |
| `ls` | List directory contents; skips `node_modules` and `.git`. |
| `grep` | Recursively search file contents for a regex pattern; skips `node_modules` and `.git`. |
| `glob` | Find files matching a glob pattern (`*`, `**`, `?`); skips `node_modules` and `.git`. |
| `Skill` | Load a skill by name; the skill body arrives as the tool result. Provided by the engine; see Skills. |

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

## Sessions & context

Every conversation is a **session**. Daedalus auto-saves the current session after each completed turn (`run()`) and when it shuts down (`dispose()`), writing it to `~/.daedalus/sessions/<id>.json` (override the directory with `DAEDALUS_SESSIONS_DIR`). One session maps to one file: the id is generated on the first save and reused across runs, and `--resume` keeps writing to the same file.

To pick up where you left off, start Daedalus with `--resume` to continue the most recent session, or `--resume <id>` for a specific one:

```bash
daedalus --resume                        # continue the latest session
daedalus --resume 2026-08-09T23-15-07    # continue a specific session
```

The persisted system prompt is reused verbatim on resume, so the prompt-cache prefix stays byte-identical across restarts.

### Context budget

History is trimmed at whole-turn boundaries when the estimated token count exceeds the context budget (`maxContextTokens`, default 100,000). The budget comes from the `DAEDALUS_MAX_CONTEXT_TOKENS` environment variable, the `maxContextTokens` config-file field, or the built-in default. A trim cuts to roughly half the budget so trims stay rare and cache misses infrequent. Skill bodies are never trimmed while the skill stays loaded. When a trim happens, Daedalus prints a `— context trimmed: N messages kept —` line.

Deferred (see the design spec): REPL `/sessions` and `/resume` commands, model-driven summarization, and exact token counting.

## Roadmap

This is a first vertical slice. Deferred items — a full permissions system (rules, allow/deny/ask, per-project settings), deeper configuration, a richer TUI, subagents/multi-agent collaboration, more tools (WebFetch/WebSearch), and more provider adapters — are tracked in the design spec:

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
