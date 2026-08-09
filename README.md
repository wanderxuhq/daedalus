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
  "baseURL": "https://api.anthropic.com"
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

Standard provider keys are also honored when `DAEDALUS_API_KEY` is not set:

- `ANTHROPIC_API_KEY` — used when the active provider is `anthropic`
- `OPENAI_API_KEY` — used when the active provider is `openai`

If no key can be found for the active provider, Daedalus exits with an error telling you which variable to set.

## Usage

```bash
daedalus [--provider openai|anthropic] [--model M] [--base-url URL] [--help]
```

| Flag | Description |
|---|---|
| `--provider openai\|anthropic` | Override the active provider |
| `--model M` | Override the model |
| `--base-url URL` | Override the provider base URL |
| `--help` | Print usage and exit |

### REPL commands

Once started you land in the REPL prompt (`›`):

| Command | Action |
|---|---|
| `/exit`, `/quit` | Leave the REPL |
| `/help` | Print available commands |

Any other input is a prompt for the agent. **Multi-line input:** type a second line (or blank line or `/run`) to submit — the buffer accumulates one line before the next input submits it. The agent runs, streams its response and tool calls, executes tools (asking `y/n` before shell commands), and reports the result.

## Tools

Seven built-in tools are registered (see `src/tools/registry.ts`):

| Tool | Description |
|---|---|
| `bash` | Execute a shell command and return its output. Always asks permission first; 2-minute timeout. |
| `read` | Read a file, optionally with a line `offset`/`limit`. Refuses to read files over 1 MB whole (pass `offset`/`limit` instead); partial reads are line-numbered. |
| `write` | Write content to a file. Asks permission before overwriting an existing file; creates parent directories automatically. |
| `edit` | Replace an exact string in a file. Errors if the string is not found or matches more than once. |
| `ls` | List directory contents; skips `node_modules` and `.git`. |
| `grep` | Recursively search file contents for a regex pattern; skips `node_modules` and `.git`. |
| `glob` | Find files matching a glob pattern (`*`, `**`, `?`); skips `node_modules` and `.git`. |

## Roadmap

This is a first vertical slice. Deferred items — a full permissions system (rules, allow/deny/ask, per-project settings), deeper configuration, a richer TUI, context compression/history trimming, session resume, subagents/multi-agent collaboration, more tools (WebFetch/WebSearch), and more provider adapters — are tracked in the design spec:

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
