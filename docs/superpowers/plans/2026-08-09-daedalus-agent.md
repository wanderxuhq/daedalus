# Daedalus Agent CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first vertical slice of Daedalus: a self-contained AI access layer (OpenAI + Anthropic via a unified IR) plus a minimal agent loop with six tools and a REPL CLI, packaged for `npx`.

**Architecture:** Daedalus talks only to an internal IR (intermediate representation) of messages/content-blocks. Each provider gets an adapter that converts IR ↔ provider wire format and wraps the provider's SSE stream as IR `StreamEvent`s. The agent loop runs `call AI → execute tools → append results → repeat` with an immutable message prefix (to maximize prompt-cache hits). CLI is a zero-dependency REPL rendering ANSI colors by hand.

**Tech Stack:** TypeScript (Node 24 native type-stripping for dev, `tsc` for dist build), Node built-in `fetch`, hand-rolled SSE parser, `node:test` for testing, no runtime third-party dependencies.

## Global Constraints

- **No node-gyp:** NEVER install any package that depends (directly or transitively) on `node-gyp`. Every dependency install must be confirmed with the user first.
- **Dev runs TS natively:** Node 24 type-stripping. No `enum`, no `namespace`, no constructor parameter properties (use `const` objects / plain classes instead). All relative imports must use explicit `.ts` extension.
- **Publishable:** `tsc` compiles `src/` → `dist/`; `package.json` `bin` exposes `daedalus` so it's callable via `npx daedalus`.
- **Zero runtime AI deps:** Hand-written fetch + SSE; no AI SDKs.
- **ESM:** `"type": "module"` in package.json.
- **Tests:** `node:test`, files under `tests/`, run with `node --test`.
- **Spec:** `docs/superpowers/specs/2026-08-09-daedalus-agent-design.md` (config & permission details are deliberately deferred; this plan implements the minimal working subset of §8 and §7.3's bash `y/n` safety confirmation).

---

### Task 1: Project scaffolding + TS + test runner

**Files:**
- Modify: `package.json`
- Create: `tsconfig.json`, `.gitignore`, `src/index.ts`, `tests/smoke.test.ts`

**Interfaces:**
- Produces: `npm test` runs node:test; `npm run build` runs tsc to `dist/`; `npm run dev` runs the CLI via node type-stripping.

- [ ] **Step 1: Update package.json**

```json
{
  "name": "daedalus",
  "version": "0.1.0",
  "description": "A Claude Code-style terminal agent with a provider-agnostic AI access layer",
  "license": "MIT",
  "type": "module",
  "bin": { "daedalus": "dist/cli/main.js" },
  "main": "dist/index.js",
  "files": ["dist"],
  "engines": { "node": ">=24" },
  "scripts": {
    "build": "tsc",
    "dev": "node src/cli/main.ts",
    "test": "node --test tests/"
  },
  "devDependencies": { "typescript": "^5.6.0" }
}
```

(Note: `dist/cli/main.js` doesn't exist until Task 9; the `bin` entry is declared now for the publishable structure. `npm run dev` is the primary run path during development.)

- [ ] **Step 2: Write tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "declaration": true,
    "sourceMap": true,
    "skipLibCheck": true,
    "verbatimModuleSyntax": true,
    "noEmitOnError": true,
    "allowImportingTsExtensions": true,
    "erasableSyntaxOnly": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Write .gitignore**

```
node_modules/
dist/
*.log
.DS_Store
```

- [ ] **Step 4: Write a smoke test**

`tests/smoke.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('smoke: test runner works', () => {
  assert.equal(1 + 1, 2);
});
```

- [ ] **Step 5: Install typescript, run tests**

Confirm with the user before installing (per Global Constraints): `npm install -D typescript`. Verify `typescript` has no `node-gyp` in its dependency tree: `npm ls node-gyp` shows nothing.

Run: `npm test`
Expected: 1 passing test.

- [ ] **Step 6: Create placeholder `src/index.ts`**

```ts
export const version = '0.1.0';
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: scaffold TS project with node:test runner"
```

---

### Task 2: IR types + AiClient interface + unified errors

**Files:**
- Create: `src/ai/types.ts`, `src/ai/errors.ts`

**Interfaces:**
- Consumes: nothing (foundation).
- Produces:
  - `type ContentBlock` (text | thinking | tool_call | tool_result) as per spec §5.1
  - `interface Message`, `interface ToolDefinition`, `interface ChatParams` (incl. optional `cache?: { enabled: boolean }`)
  - `type StreamEvent` (text_delta | thinking_delta | tool_call_start | tool_call_delta | done | error)
  - `interface AiClient { streamChat(params: ChatParams): AsyncIterable<StreamEvent> }`
  - `class AiError extends Error` with `kind: AiErrorKind` where `AiErrorKind = 'auth' | 'rateLimit' | 'server' | 'badRequest' | 'timeout' | 'network' | 'parse'`, plus `status?: number`, `retryable: boolean`.

- [ ] **Step 1: Write failing tests for errors.ts**

`tests/ai/errors.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AiError } from '../../src/ai/errors.ts';

test('AiError carries kind and retryable flag', () => {
  const e = new AiError('rateLimit', 'slow down', 429);
  assert.equal(e.kind, 'rateLimit');
  assert.equal(e.retryable, true);
  assert.equal(e.message, 'slow down');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/ai/errors.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement errors.ts**

```ts
export type AiErrorKind =
  | 'auth' | 'rateLimit' | 'server' | 'badRequest' | 'timeout' | 'network' | 'parse';

const RETRYABLE = new Set<AiErrorKind>(['rateLimit', 'server', 'timeout', 'network']);

export class AiError extends Error {
  readonly kind: AiErrorKind;
  readonly status?: number;
  readonly retryable: boolean;

  constructor(kind: AiErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'AiError';
    this.kind = kind;
    this.status = status;
    this.retryable = RETRYABLE.has(kind);
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test tests/ai/errors.test.ts`
Expected: PASS.

- [ ] **Step 5: Write failing types tests**

`tests/ai/types.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Message, StreamEvent, AiClient, ChatParams, ToolDefinition } from '../../src/ai/types.ts';

test('IR types are structurally sound', () => {
  const msg: Message = {
    role: 'assistant',
    content: [{ type: 'tool_call', id: 't1', name: 'bash', input: { command: 'ls' } }],
  };
  assert.equal(msg.content[0].type, 'tool_call');
  const ev: StreamEvent = { type: 'text_delta', text: 'hi' };
  assert.equal(ev.type, 'text_delta');
  const params: ChatParams = { model: 'm', messages: [msg], cache: { enabled: true } };
  assert.equal(params.cache?.enabled, true);
  const td: ToolDefinition = { name: 'bash', description: 'run', inputSchema: { type: 'object' } };
  assert.equal(td.inputSchema.type, 'object');
  const client: AiClient = { streamChat: async function* () {} };
  assert.equal(typeof client.streamChat, 'function');
});
```

- [ ] **Step 6: Run to verify failure**

Run: `node --test tests/ai/types.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 7: Implement types.ts**

```ts
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolCallId: string; content: string; isError?: boolean };

export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: ContentBlock[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface ChatParams {
  model?: string;           // optional: client-level default is applied when omitted
  messages: Message[];
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  cache?: { enabled: boolean };
}

export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'tool_call_start'; id: string; name: string }
  | { type: 'tool_call_delta'; id: string; inputDelta: string }
  | { type: 'done'; message: Message }
  | { type: 'error'; error: AiError };

import type { AiError } from './errors.ts';

export interface AiClient {
  streamChat(params: ChatParams): AsyncIterable<StreamEvent>;
}
```

- [ ] **Step 8: Run to verify pass + typecheck**

Run: `node --test tests/ai/errors.test.ts tests/ai/types.test.ts`
Expected: PASS.

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: add IR types, AiClient interface, unified AiError"
```

---

### Task 3: SSE parser

**Files:**
- Create: `src/ai/sse.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `async function* parseSseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<string>` — yields the `data:` payload of each SSE event (strips `data: ` prefix and trailing newline, handles CRLF, multi-line `data:` fields folded with `\n`, ignores comments / event lines).

- [ ] **Step 1: Write failing tests**

`tests/ai/sse.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSseStream } from '../../src/ai/sse.ts';

async function collect(chunks: string[]): Promise<string[]> {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
      controller.close();
    },
  });
  return parseSseStream(stream).toArray ? [] : [];
}
```

**Test helper note:** use a small async generator wrapper instead of `.toArray()` (not available). Use this helper:

```ts
async function collect(chunks: string[]): Promise<string[]> {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
      controller.close();
    },
  });
  const out: string[] = [];
  for await (const ev of parseSseStream(stream)) out.push(ev);
  return out;
}
```

Tests:

```ts
test('parses a single event', async () => {
  const evs = await collect(['data: hello\n\n']);
  assert.deepEqual(evs, ['hello']);
});

test('parses multiple events including CRLF', async () => {
  const evs = await collect(['data: one\r\n\r\ndata: two\n\n']);
  assert.deepEqual(evs, ['one', 'two']);
});

test('handles chunked/broken lines', async () => {
  const evs = await collect(['data: ab', 'c\n\n', 'data: x\n\n']);
  assert.deepEqual(evs, ['abc', 'x']);
});

test('folds multi-line data fields with newline', async () => {
  const evs = await collect(['data: line1\ndata: line2\n\n']);
  assert.deepEqual(evs, ['line1\nline2']);
});

test('ignores comment lines and empty data', async () => {
  const evs = await collect([': comment\ndata:\n\ndata: real\n\n']);
  assert.deepEqual(evs, ['', 'real']);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/ai/sse.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement sse.ts**

```ts
export async function* parseSseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        yield* handleLine(line);
      }
    }
    // flush trailing line
    if (buffer.length > 0) yield* handleLine(buffer.replace(/\r$/, ''));
  } finally {
    reader.releaseLock();
  }
}

function* handleLine(line: string): Generator<string> {
  if (line.startsWith('data:')) {
    const payload = line.slice(5).replace(/^ /, '');
    yield payload;
  }
  // ':' comment lines and 'event:'/'id:' lines are ignored
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test tests/ai/sse.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add SSE stream parser"
```

---

### Task 4: HTTP helper (fetch wrapper with retry/timeout)

**Files:**
- Create: `src/ai/http.ts`

**Interfaces:**
- Consumes: `AiError` from `errors.ts`.
- Produces:
  - `interface HttpClientConfig { baseURL: string; apiKey: string; timeoutMs?: number; maxRetries?: number; }`
  - `class HttpClient` with:
    - `constructor(config: HttpClientConfig)`
    - `stream(path: string, body: unknown, opts?: { signal?: AbortSignal }): Promise<ReadableStream<Uint8Array>>` — POSTs `JSON.stringify(body)` with `Authorization: Bearer <apiKey>` and `Content-Type: application/json`, throws `AiError` on non-2xx, returns the response body stream on success. Retries `retryable` errors up to `maxRetries` with exponential backoff (base 500ms × 2^n).

- [ ] **Step 1: Write failing tests with a mock fetch**

`tests/ai/http.test.ts`:
```ts
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { HttpClient } from '../../src/ai/http.ts';
import { AiError } from '../../src/ai/errors.ts';

test('throws auth AiError on 401', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = mock.fn(async () =>
    new Response('{"error":{"message":"bad key"}}', { status: 401 })) as typeof fetch;
  const client = new HttpClient({ baseURL: 'https://x', apiKey: 'k' });
  await assert.rejects(() => client.stream('/chat', {}), (e: unknown) => {
    assert.ok(e instanceof AiError);
    assert.equal((e as AiError).kind, 'auth');
    return true;
  });
  globalThis.fetch = origFetch;
});

test('retries on 429 then succeeds', async () => {
  const origFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = mock.fn(async () => {
    calls++;
    if (calls === 1) return new Response('', { status: 429 });
    return new Response('ok');
  }) as typeof fetch;
  const client = new HttpClient({ baseURL: 'https://x', apiKey: 'k', maxRetries: 2, timeoutMs: 1000 });
  const stream = await client.stream('/chat', {});
  const text = await new Response(stream).text();
  assert.equal(text, 'ok');
  assert.equal(calls, 2);
  globalThis.fetch = origFetch;
});

test('gives up after maxRetries on persistent 5xx', async () => {
  const origFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = mock.fn(async () => { calls++; return new Response('', { status: 500 }); }) as typeof fetch;
  const client = new HttpClient({ baseURL: 'https://x', apiKey: 'k', maxRetries: 2 });
  await assert.rejects(() => client.stream('/chat', {}), (e: unknown) => {
    assert.equal((e as AiError).kind, 'server');
    return true;
  });
  assert.equal(calls, 3); // initial + 2 retries
  globalThis.fetch = origFetch;
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/ai/http.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement http.ts**

```ts
import { AiError } from './errors.ts';

export interface HttpClientConfig {
  baseURL: string;
  apiKey: string;
  timeoutMs?: number;
  maxRetries?: number;
}

const DEFAULT_TIMEOUT = 120_000;
const DEFAULT_MAX_RETRIES = 3;

export class HttpClient {
  private readonly baseURL: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(config: HttpClientConfig) {
    this.baseURL = config.baseURL.replace(/\/$/, '');
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT;
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  async stream(path: string, body: unknown, opts?: { signal?: AbortSignal }): Promise<ReadableStream<Uint8Array>> {
    const url = `${this.baseURL}${path}`;
    let attempt = 0;
    while (true) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      const signal = opts?.signal;
      const onAbort = () => controller.abort();
      signal?.addEventListener('abort', onAbort);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          const kind = res.status === 401 || res.status === 403 ? 'auth'
            : res.status === 429 ? 'rateLimit'
            : res.status >= 500 ? 'server'
            : 'badRequest';
          const err = new AiError(kind, `HTTP ${res.status}: ${errText.slice(0, 300)}`, res.status);
          if (err.retryable && attempt < this.maxRetries) {
            attempt++;
            await sleep(500 * 2 ** attempt);
            continue;
          }
          throw err;
        }
        return res.body!;
      } catch (e) {
        if (e instanceof AiError) throw e;
        const aborted = (e as Error).name === 'AbortError';
        const kind = aborted ? 'timeout' : 'network';
        const err = new AiError(kind, (e as Error).message);
        if (err.retryable && attempt < this.maxRetries) {
          attempt++;
          await sleep(500 * 2 ** attempt);
          continue;
        }
        throw err;
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test tests/ai/http.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add HTTP client with retry and timeout"
```

---

### Task 5: Anthropic adapter

**Files:**
- Create: `src/ai/providers/anthropic.ts`

**Interfaces:**
- Consumes: `AiClient`, `ChatParams`, `StreamEvent`, `Message`, `ToolDefinition`, `ContentBlock` from `types.ts`; `AiError` from `errors.ts`; `parseSseStream` from `sse.ts`; `HttpClient` from `http.ts`.
- Produces: `function createAnthropicClient(config: { apiKey: string; baseURL?: string; model?: string; maxRetries?: number; timeoutMs?: number }): AiClient`

**Behavior (per spec §5.2, §5.3):**
- Request: `POST {baseURL}/v1/messages`. IR → body:
  - `system`: concat of `system` messages' text blocks (when present).
  - `messages`: map each non-system IR message; `assistant` with `tool_call` blocks → `{ role: "assistant", content: [{ type: "tool_use", id, name, input }] }`; `user` with `tool_result` blocks → `{ role: "user", content: [{ type: "tool_result", tool_use_id, content, is_error }] }`; text blocks → `{ type: "text", text }`.
  - `tools`: map `ToolDefinition` → `{ name, description, input_schema: inputSchema }`.
  - `model`, `max_tokens` (default 8192), `temperature` (if set).
  - **Cache (spec §5.2):** when `cache?.enabled` is not `false`, add `cache_control: { type: "ephemeral" }` to the last block of `system`, each `tools[]` entry, and the last message in `messages` (the growing prefix tail — actual breakpoint tuning is deferred; this provides the mechanism).
- Stream: `POST /v1/messages` with `Accept: text/event-stream` (HttpClient adds Bearer). Parse SSE events (`event:` lines are ignored by our parser; payloads are JSON). Handle:
  - `content_block_delta` with `delta.type === "text_delta"` → `{ type: 'text_delta', text }`
  - `content_block_start` with `content_block.type === "thinking"` → `{ type: 'thinking_delta', thinking: '' }` then subsequent `thinking_delta`s; accumulate thinking.
  - `content_block_start` with `content_block.type === "tool_use"` → `{ type: 'tool_call_start', id, name }`; accumulate JSON input.
  - `content_block_delta` with `delta.type === "input_json_delta"` → `{ type: 'tool_call_delta', id, inputDelta: delta.partial_json }`
  - `message_stop` → parse accumulated blocks into an IR `Message`, emit `{ type: 'done', message }`.
  - `error` event → `AiError('server', ...)`.
- Note: parse failure throws `AiError('parse', ...)`.

- [ ] **Step 1: Write failing conversion tests**

`tests/ai/providers/anthropic.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toAnthropicBody } from '../../src/ai/providers/anthropic.ts';
import type { Message, ToolDefinition } from '../../src/ai/types.ts';

test('converts IR system+text to anthropic body', () => {
  const messages: Message[] = [
    { role: 'system', content: [{ type: 'text', text: 'You are helpful' }] },
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
  ];
  const tools: ToolDefinition[] = [{ name: 'bash', description: 'run', inputSchema: { type: 'object' } }];
  const body = toAnthropicBody({ model: 'claude-sonnet-4-5', messages, tools, maxTokens: 2048 });
  assert.equal(body.system, 'You are helpful');
  assert.equal(body.messages[0].role, 'user');
  assert.equal(body.messages[0].content[0].type, 'text');
  assert.equal(body.max_tokens, 2048);
  assert.equal(body.tools[0].input_schema.type, 'object');
});

test('marks cache_control on stable blocks when cache enabled', () => {
  const messages: Message[] = [
    { role: 'system', content: [{ type: 'text', text: 'sys' }] },
    { role: 'user', content: [{ type: 'text', text: 'u' }] },
  ];
  const body = toAnthropicBody({ model: 'm', messages, cache: { enabled: true } });
  assert.deepEqual((body.system as Record<string, unknown>).cache_control, { type: 'ephemeral' });
  assert.deepEqual((body.messages as Record<string, unknown>[])[(body.messages as unknown[]).length - 1].cache_control, { type: 'ephemeral' });
});

test('converts tool_call and tool_result blocks', () => {
  const messages: Message[] = [
    { role: 'assistant', content: [{ type: 'tool_call', id: 't1', name: 'bash', input: { command: 'ls' } }] },
    { role: 'user', content: [{ type: 'tool_result', toolCallId: 't1', content: 'out', isError: false }] },
  ];
  const body = toAnthropicBody({ model: 'm', messages });
  assert.equal(body.messages[0].content[0].type, 'tool_use');
  assert.equal(body.messages[0].content[0].id, 't1');
  assert.equal(body.messages[1].content[0].type, 'tool_result');
  assert.equal(body.messages[1].content[0].tool_use_id, 't1');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/ai/providers/anthropic.test.ts`
Expected: FAIL — `toAnthropicBody` not exported.

- [ ] **Step 3: Implement the request-side conversion (`toAnthropicBody`)**

`src/ai/providers/anthropic.ts` (start with request side; add `streamChat` in Step 6):
```ts
import type { ChatParams, Message, StreamEvent, ContentBlock, ToolDefinition } from '../types.ts';
import { AiError } from '../errors.ts';
import { parseSseStream } from '../sse.ts';
import { HttpClient } from '../http.ts';

export interface AnthropicClientConfig {
  apiKey: string;
  baseURL?: string;
  model?: string;
  maxRetries?: number;
  timeoutMs?: number;
}

const DEFAULT_MODEL = 'claude-sonnet-4-5';
const DEFAULT_BASE = 'https://api.anthropic.com';
const DEFAULT_MAX_TOKENS = 8192;

export function toAnthropicBody(params: ChatParams): Record<string, unknown> {
  const systemText = params.messages
    .filter((m) => m.role === 'system')
    .flatMap((m) => m.content)
    .filter((c): c is Extract<ContentBlock, { type: 'text' }> => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

  const body: Record<string, unknown> = {
    model: params.model,
    max_tokens: params.maxTokens ?? DEFAULT_MAX_TOKENS,
  };
  if (systemText) body.system = systemText;
  if (params.temperature !== undefined) body.temperature = params.temperature;

  const cacheEnabled = params.cache?.enabled !== false;

  if (cacheEnabled && systemText) {
    body.system = { type: 'text', text: systemText, cache_control: { type: 'ephemeral' } };
  }

  const messages = params.messages.filter((m) => m.role !== 'system').map((m) => toAnthropicMessage(m));
  if (messages.length > 0 && cacheEnabled) {
    const last = messages[messages.length - 1] as Record<string, unknown>;
    last.cache_control = { type: 'ephemeral' };
  }
  body.messages = messages;

  if (params.tools?.length) {
    body.tools = params.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
      ...(cacheEnabled ? { cache_control: { type: 'ephemeral' } } : {}),
    }));
  }

  return body;
}

function toAnthropicMessage(m: Message): Record<string, unknown> {
  const content = m.content.map((block): Record<string, unknown> => {
    switch (block.type) {
      case 'text':
        return { type: 'text', text: block.text };
      case 'thinking':
        return { type: 'thinking', thinking: block.thinking };
      case 'tool_call':
        return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
      case 'tool_result':
        return {
          type: 'tool_result',
          tool_use_id: block.toolCallId,
          content: block.content,
          ...(block.isError ? { is_error: true } : {}),
        };
    }
  });
  return { role: m.role, content };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test tests/ai/providers/anthropic.test.ts`
Expected: PASS.

- [ ] **Step 5: Write failing stream-to-IR tests**

Append to `tests/ai/providers/anthropic.test.ts`:
```ts
import { anthropicEventsToIR } from '../../src/ai/providers/anthropic.ts';

test('converts anthropic SSE payloads to IR events', () => {
  const payloads = [
    { type: 'message_start', message: { id: 'm1' } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't1', name: 'bash', input: {} } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"c' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'ommand":"ls"}' } },
    { type: 'message_stop' },
  ];
  const events = anthropicEventsToIR(payloads);
  const types = events.map((e) => e.type);
  assert.deepEqual(types, [
    'text_delta', 'text_delta', 'tool_call_start', 'tool_call_delta', 'tool_call_delta', 'done',
  ]);
  const done = events.find((e) => e.type === 'done')!;
  assert.equal(done.type, 'done');
  const tc = done.message.content.find((c) => c.type === 'tool_call')!;
  assert.equal(tc.type, 'tool_call');
  assert.deepEqual(tc.input, { command: 'ls' });
});
```

- [ ] **Step 6: Run to verify failure**

Run: `node --test tests/ai/providers/anthropic.test.ts`
Expected: FAIL — `anthropicEventsToIR` not exported.

- [ ] **Step 7: Implement event conversion + `createAnthropicClient`**

Append to `src/ai/providers/anthropic.ts`:

```ts
import type { StreamEvent } from '../types.ts';

export function anthropicEventsToIR(payloads: Record<string, unknown>[]): StreamEvent[] {
  const events: StreamEvent[] = [];
  const blocks: { type: string; id?: string; name?: string; text?: string; thinking?: string; inputJson?: string }[] = [];

  for (const p of payloads) {
    switch (p.type) {
      case 'content_block_start': {
        const cb = p.content_block as { type: string; id?: string; name?: string; text?: string; thinking?: string };
        blocks.push({ type: cb.type, id: cb.id, name: cb.name, text: cb.text ?? '', thinking: cb.thinking ?? '' });
        if (cb.type === 'thinking') events.push({ type: 'thinking_delta', thinking: '' });
        if (cb.type === 'tool_use') events.push({ type: 'tool_call_start', id: cb.id!, name: cb.name! });
        break;
      }
      case 'content_block_delta': {
        const delta = p.delta as { type: string; text?: string; thinking?: string; partial_json?: string };
        const block = blocks[p.index as number];
        if (delta.type === 'text_delta' && delta.text) {
          if (block) block.text = (block.text ?? '') + delta.text;
          events.push({ type: 'text_delta', text: delta.text });
        } else if (delta.type === 'thinking_delta' && delta.thinking) {
          if (block) block.thinking = (block.thinking ?? '') + delta.thinking;
          events.push({ type: 'thinking_delta', thinking: delta.thinking });
        } else if (delta.type === 'input_json_delta' && delta.partial_json) {
          if (block) block.inputJson = (block.inputJson ?? '') + delta.partial_json;
          events.push({ type: 'tool_call_delta', id: block?.id ?? '', inputDelta: delta.partial_json });
        }
        break;
      }
      case 'message_stop': {
        const content: import('../types.ts').ContentBlock[] = blocks.map((b) => {
          if (b.type === 'text') return { type: 'text', text: b.text ?? '' };
          if (b.type === 'thinking') return { type: 'thinking', thinking: b.thinking ?? '' };
          if (b.type === 'tool_use') {
            let input: unknown = {};
            try { input = JSON.parse(b.inputJson ?? '{}'); } catch { input = b.inputJson ?? {}; }
            return { type: 'tool_call', id: b.id!, name: b.name!, input };
          }
          return { type: 'text', text: '' };
        });
        events.push({ type: 'done', message: { role: 'assistant', content } });
        break;
      }
      case 'error': {
        const err = p.error as { message?: string };
        events.push({ type: 'error', error: new AiError('server', err?.message ?? 'unknown error') });
        break;
      }
      default:
        break;
    }
  }
  return events;
}

export function createAnthropicClient(config: AnthropicClientConfig): import('../types.ts').AiClient {
  const baseURL = config.baseURL ?? DEFAULT_BASE;
  const model = config.model ?? DEFAULT_MODEL;
  const http = new HttpClient({
    baseURL,
    apiKey: config.apiKey,
    maxRetries: config.maxRetries,
    timeoutMs: config.timeoutMs,
  });

  return {
    async *streamChat(params: ChatParams): AsyncIterable<StreamEvent> {
      const body = toAnthropicBody({ ...params, model: params.model ?? model });
      let stream: ReadableStream<Uint8Array>;
      try {
        stream = await http.stream('/v1/messages', body, { signal: params.signal });
      } catch (e) {
        if (e instanceof AiError) {
          yield { type: 'error', error: e };
          return;
        }
        throw e;
      }
      try {
        for await (const data of parseSseStream(stream)) {
          if (!data) continue;
          let payload: Record<string, unknown>;
          try { payload = JSON.parse(data); } catch { throw new AiError('parse', `bad SSE JSON: ${data.slice(0, 100)}`); }
          for (const ev of anthropicEventsToIR([payload])) yield ev;
        }
      } catch (e) {
        if (e instanceof AiError) { yield { type: 'error', error: e }; return; }
        throw e;
      }
    },
  };
}
```

- [ ] **Step 8: Run to verify pass + typecheck**

Run: `node --test tests/ai/providers/anthropic.test.ts`
Expected: PASS.

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: add Anthropic adapter with cache_control support"
```

---

### Task 6: OpenAI adapter

**Files:**
- Create: `src/ai/providers/openai.ts`

**Interfaces:**
- Consumes: `types.ts`, `errors.ts`, `sse.ts`, `http.ts`.
- Produces: `function createOpenAIClient(config: { apiKey: string; baseURL?: string; model?: string; maxRetries?: number; timeoutMs?: number }): AiClient`, plus exported helpers `toOpenAIBody(params)` and `openaiEventsToIR(payloads)`.

**Behavior (per spec §5.3, §5.2):**
- Request: `POST {baseURL}/chat/completions`. IR → body:
  - `messages`: map each IR message.
    - `system` → `{ role: "system", content: <text> }`
    - `user` text → `{ role: "user", content: <text> }`; `user` with `tool_result` blocks → `{ role: "tool", tool_call_id, content }` messages (one per block).
    - `assistant` text → `{ role: "assistant", content: <text> }`; `assistant` with `tool_call` blocks → `{ role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(input) } }] }`.
  - `tools`: `[{ type: "function", function: { name, description, parameters: inputSchema } }]`.
  - `model`, `max_tokens`, `temperature`, `stream: true`.
  - **Cache (spec §5.2):** OpenAI caches automatically on stable prefixes; no body markers needed. Just ensure stable ordering (which IR guarantees). No-op otherwise.
- Stream: SSE from `chat/completions`. Handle payloads:
  - `choices[0].delta.content` → `{ type: 'text_delta', text }`
  - `choices[0].delta.tool_calls[]` with `.function.arguments` → `{ type: 'tool_call_start', id, name }` on `.index` first seen, then `{ type: 'tool_call_delta', id, inputDelta }`
  - `choices[0].finish_reason` present (and no more deltas) → emit `{ type: 'done', message }` assembled from accumulated deltas.
  - `[DONE]` sentinel ends the stream.
  - top-level `error` → `AiError('badRequest' | 'server', ...)`.

- [ ] **Step 1: Write failing request conversion tests**

`tests/ai/providers/openai.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toOpenAIBody } from '../../src/ai/providers/openai.ts';
import type { Message, ToolDefinition } from '../../src/ai/types.ts';

test('converts system+user to openai body', () => {
  const messages: Message[] = [
    { role: 'system', content: [{ type: 'text', text: 'You are helpful' }] },
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
  ];
  const body = toOpenAIBody({ model: 'gpt-4o', messages });
  assert.equal(body.stream, true);
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages[0].content, 'You are helpful');
  assert.equal(body.messages[1].role, 'user');
});

test('converts tool_call and tool_result to openai format', () => {
  const messages: Message[] = [
    { role: 'assistant', content: [{ type: 'tool_call', id: 't1', name: 'bash', input: { command: 'ls' } }] },
    { role: 'user', content: [{ type: 'tool_result', toolCallId: 't1', content: 'out' }] },
  ];
  const body = toOpenAIBody({ model: 'm', messages });
  assert.equal(body.messages[0].content, null);
  assert.equal(body.messages[0].tool_calls[0].function.name, 'bash');
  assert.equal(body.messages[0].tool_calls[0].function.arguments, '{"command":"ls"}');
  assert.equal(body.messages[1].role, 'tool');
  assert.equal(body.messages[1].tool_call_id, 't1');
});

test('converts tool definitions', () => {
  const tools: ToolDefinition[] = [{ name: 'bash', description: 'run', inputSchema: { type: 'object' } }];
  const body = toOpenAIBody({ model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }], tools });
  assert.equal(body.tools[0].type, 'function');
  assert.equal(body.tools[0].function.parameters.type, 'object');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/ai/providers/openai.test.ts`
Expected: FAIL — `toOpenAIBody` not exported.

- [ ] **Step 3: Implement request conversion**

`src/ai/providers/openai.ts`:
```ts
import type { ChatParams, Message, StreamEvent, ContentBlock } from '../types.ts';
import { AiError } from '../errors.ts';
import { parseSseStream } from '../sse.ts';
import { HttpClient } from '../http.ts';

export interface OpenAIClientConfig {
  apiKey: string;
  baseURL?: string;
  model?: string;
  maxRetries?: number;
  timeoutMs?: number;
}

const DEFAULT_MODEL = 'gpt-4o';
const DEFAULT_BASE = 'https://api.openai.com/v1';

export function toOpenAIBody(params: ChatParams): Record<string, unknown> {
  const messages: Record<string, unknown>[] = [];
  for (const m of params.messages) {
    if (m.role === 'system') {
      const text = m.content.filter((c): c is Extract<ContentBlock, { type: 'text' }> => c.type === 'text').map((c) => c.text).join('\n');
      messages.push({ role: 'system', content: text });
      continue;
    }
    if (m.role === 'user') {
      const textBlocks = m.content.filter((c): c is Extract<ContentBlock, { type: 'text' }> => c.type === 'text');
      const results = m.content.filter((c): c is Extract<ContentBlock, { type: 'tool_result' }> => c.type === 'tool_result');
      if (textBlocks.length) messages.push({ role: 'user', content: textBlocks.map((c) => c.text).join('\n') });
      for (const r of results) messages.push({ role: 'tool', tool_call_id: r.toolCallId, content: r.content });
      continue;
    }
    // assistant
    const text = m.content.filter((c): c is Extract<ContentBlock, { type: 'text' }> => c.type === 'text').map((c) => c.text).join('\n');
    const calls = m.content.filter((c): c is Extract<ContentBlock, { type: 'tool_call' }> => c.type === 'tool_call');
    const msg: Record<string, unknown> = { role: 'assistant', content: text || null };
    if (calls.length) {
      msg.content = null;
      msg.tool_calls = calls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: JSON.stringify(c.input) },
      }));
    }
    messages.push(msg);
  }

  const body: Record<string, unknown> = {
    model: params.model,
    messages,
    stream: true,
  };
  if (params.maxTokens !== undefined) body.max_tokens = params.maxTokens;
  if (params.temperature !== undefined) body.temperature = params.temperature;
  if (params.tools?.length) {
    body.tools = params.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));
  }
  return body;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test tests/ai/providers/openai.test.ts`
Expected: PASS.

- [ ] **Step 5: Write failing stream-to-IR tests**

Append to `tests/ai/providers/openai.test.ts`:
```ts
import { openaiEventsToIR } from '../../src/ai/providers/openai.ts';

test('converts openai SSE payloads to IR events', () => {
  const payloads = [
    { choices: [{ delta: { content: 'Hi' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 't1', type: 'function', function: { name: 'bash', arguments: '{"com' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'mand":"ls"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ];
  const events = openaiEventsToIR(payloads);
  const types = events.map((e) => e.type);
  assert.deepEqual(types, ['text_delta', 'tool_call_start', 'tool_call_delta', 'tool_call_delta', 'done']);
  const done = events.find((e) => e.type === 'done')!;
  assert.equal(done.type, 'done');
  const tc = done.message.content.find((c) => c.type === 'tool_call')!;
  assert.equal(tc.type, 'tool_call');
  assert.deepEqual(tc.input, { command: 'ls' });
});
```

- [ ] **Step 6: Run to verify failure**

Run: `node --test tests/ai/providers/openai.test.ts`
Expected: FAIL — `openaiEventsToIR` not exported.

- [ ] **Step 7: Implement event conversion + `createOpenAIClient`**

Append to `src/ai/providers/openai.ts`:

```ts
export function openaiEventsToIR(payloads: Record<string, unknown>[]): StreamEvent[] {
  const events: StreamEvent[] = [];
  const textParts: string[] = [];
  const calls = new Map<number, { id: string; name: string; argParts: string[]; started: boolean }>();

  for (const p of payloads) {
    const choices = (p.choices ?? []) as Record<string, unknown>[];
    for (const choice of choices) {
      const delta = (choice.delta ?? {}) as Record<string, unknown>;
      if (typeof delta.content === 'string' && delta.content) {
        textParts.push(delta.content);
        events.push({ type: 'text_delta', text: delta.content });
      }
      const tcs = delta.tool_calls as Record<string, unknown>[] | undefined;
      if (tcs) {
        for (const tc of tcs) {
          const idx = tc.index as number;
          const fn = (tc.function ?? {}) as Record<string, unknown>;
          const fnName = typeof fn.name === 'string' ? fn.name : undefined;
          const args = typeof fn.arguments === 'string' ? fn.arguments : '';
          if (!calls.has(idx)) calls.set(idx, { id: '', name: '', argParts: [], started: false });
          const call = calls.get(idx)!;
          if (tc.id) call.id = tc.id as string;
          if (fnName) call.name = fnName;
          if (!call.started && call.id && call.name) {
            call.started = true;
            events.push({ type: 'tool_call_start', id: call.id, name: call.name });
          }
          if (args) {
            call.argParts.push(args);
            events.push({ type: 'tool_call_delta', id: call.id, inputDelta: args });
          }
        }
      }
      if (typeof choice.finish_reason === 'string' && choice.finish_reason) {
        const content: ContentBlock[] = [];
        if (textParts.length) content.push({ type: 'text', text: textParts.join('') });
        for (const call of calls.values()) {
          if (!call.id || !call.name) continue;
          let input: unknown = {};
          try { input = JSON.parse(call.argParts.join('')); } catch { input = call.argParts.join(''); }
          content.push({ type: 'tool_call', id: call.id, name: call.name, input });
        }
        events.push({ type: 'done', message: { role: 'assistant', content } });
      }
    }
    if (p.error) {
      const err = p.error as { message?: string };
      events.push({ type: 'error', error: new AiError('server', err?.message ?? 'unknown error') });
    }
  }
  return events;
}

export function createOpenAIClient(config: OpenAIClientConfig): import('../types.ts').AiClient {
  const baseURL = config.baseURL ?? DEFAULT_BASE;
  const model = config.model ?? DEFAULT_MODEL;
  const http = new HttpClient({ baseURL, apiKey: config.apiKey, maxRetries: config.maxRetries, timeoutMs: config.timeoutMs });

  return {
    async *streamChat(params: ChatParams): AsyncIterable<StreamEvent> {
      const body = toOpenAIBody({ ...params, model: params.model ?? model });
      let stream: ReadableStream<Uint8Array>;
      try {
        stream = await http.stream('/chat/completions', body, { signal: params.signal });
      } catch (e) {
        if (e instanceof AiError) { yield { type: 'error', error: e }; return; }
        throw e;
      }
      try {
        for await (const data of parseSseStream(stream)) {
          if (data === '[DONE]') break;
          if (!data) continue;
          let payload: Record<string, unknown>;
          try { payload = JSON.parse(data); } catch { throw new AiError('parse', `bad SSE JSON: ${data.slice(0, 100)}`); }
          for (const ev of openaiEventsToIR([payload])) yield ev;
        }
      } catch (e) {
        if (e instanceof AiError) { yield { type: 'error', error: e }; return; }
        throw e;
      }
    },
  };
}
```

- [ ] **Step 8: Run to verify pass + typecheck**

Run: `node --test tests/ai/providers/openai.test.ts`
Expected: PASS.

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: add OpenAI adapter with stable-prefix support"
```

---

### Task 7: AiClient factory + index

**Files:**
- Create: `src/ai/index.ts`

**Interfaces:**
- Consumes: `createAnthropicClient`, `createOpenAIClient`, `AiClient`, `AiError`.
- Produces:
  - `export type AiProviderName = 'openai' | 'anthropic'`
  - `export function createAiClient(config: { provider: AiProviderName; apiKey: string; baseURL?: string; model?: string; maxRetries?: number; timeoutMs?: number }): AiClient`
  - Re-export `AiClient`, `StreamEvent`, `Message`, `ContentBlock`, `ToolDefinition`, `ChatParams`, `AiError`, `AiErrorKind` from the ai layer for daedalus consumers.

- [ ] **Step 1: Write failing test**

`tests/ai/index.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAiClient, type AiProviderName } from '../../src/ai/index.ts';

test('factory returns a client for known providers', () => {
  const client = createAiClient({ provider: 'anthropic', apiKey: 'k' });
  assert.equal(typeof client.streamChat, 'function');
});

test('factory throws for unknown provider', () => {
  assert.throws(() => createAiClient({ provider: 'bogus' as AiProviderName, apiKey: 'k' }));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/ai/index.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement index.ts**

```ts
import { createAnthropicClient } from './providers/anthropic.ts';
import { createOpenAIClient } from './providers/openai.ts';

export type AiProviderName = 'openai' | 'anthropic';

export interface AiClientConfig {
  provider: AiProviderName;
  apiKey: string;
  baseURL?: string;
  model?: string;
  maxRetries?: number;
  timeoutMs?: number;
}

export function createAiClient(config: AiClientConfig) {
  switch (config.provider) {
    case 'anthropic':
      return createAnthropicClient(config);
    case 'openai':
      return createOpenAIClient(config);
    default:
      throw new Error(`Unknown provider: ${config.provider as string}`);
  }
}

export type { AiClient, StreamEvent, Message, ContentBlock, ToolDefinition, ChatParams } from './types.ts';
export { AiError } from './errors.ts';
export type { AiErrorKind } from './errors.ts';
```

- [ ] **Step 4: Run to verify pass + typecheck**

Run: `node --test tests/ai/index.test.ts`
Expected: PASS.

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add AiClient factory"
```

---

### Task 8: Tools — Tool interface, registry, six implementations

**Files:**
- Create: `src/tools/types.ts`, `src/tools/registry.ts`, `src/tools/bash.ts`, `src/tools/read.ts`, `src/tools/write.ts`, `src/tools/edit.ts`, `src/tools/ls.ts`, `src/tools/grep.ts`, `src/tools/glob.ts`

**Interfaces:**
- Consumes: `ToolDefinition` from `ai/types.ts`.
- Produces:
  - `interface ToolResult { content: string; isError?: boolean }`
  - `interface ToolContext { cwd: string; askPermission: (action: string, target: string) => Promise<boolean> }`
  - `interface Tool { name: string; description: string; inputSchema: ToolDefinition['inputSchema']; execute(input: unknown, ctx: ToolContext): Promise<ToolResult> }`
  - `const tools: Tool[]` (all six registered), exported from `registry.ts`.

**Implementation notes (spec §7):**
- bash: `spawn` from `node:child_process` with `cwd`, timeout default 120s, always call `ctx.askPermission('bash', command)` first; if denied → `{ content: 'Permission denied by user', isError: true }`. Non-zero exit → `{ content: stdout + stderr, isError: true }`.
- read: `fs.promises.readFile`; reject files > 1MB with a hint to use `offset/limit`; optional `offset`/`limit` lines. Input `{ path, offset?, limit? }`.
- write: `fs.promises.mkdir(dirname, { recursive: true })`; if file exists → `ctx.askPermission('write', path)`; if denied → error result. Input `{ path, content }`.
- edit: exact string replace; input `{ path, oldString, newString }`; if oldString not found or not unique → error result.
- ls: `fs.promises.readdir` with `{ withFileTypes: true }`, filter out `node_modules`/`.git`, format `name` + `/` for dirs. Input `{ path? }`.
- grep: recursive `fs.promises.readdir`, skip `node_modules`/`.git`, match `new RegExp(pattern)` on file text, output `path:line:text`. Input `{ pattern, path? }`.
- glob: minimal `*`/`**`/`?` matcher over recursive listing; Input `{ pattern, path? }`. Implement `matchesGlob(pattern, str)` helper (exported for tests).

- [ ] **Step 1: Write failing unit tests for each tool**

`tests/tools/tools.test.ts`:
```ts
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { tools } from '../../src/tools/registry.ts';
import { matchesGlob } from '../../src/tools/glob.ts';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function makeCtx(overrides?: Partial<{ askPermission: ToolContext['askPermission'] }>): ToolContext {
  return { cwd: process.cwd(), askPermission: overrides?.askPermission ?? (async () => true) };
}
```

(Include `import type { ToolContext } from '../../src/tools/types.ts';`)

Tests:

```ts
test('glob matcher: star, globstar, question', () => {
  assert.equal(matchesGlob('*.ts', 'a.ts'), true);
  assert.equal(matchesGlob('*.ts', 'a.js'), false);
  assert.equal(matchesGlob('src/**/*.ts', 'src/a/b.ts'), true);
  assert.equal(matchesGlob('a?c', 'abc'), true);
  assert.equal(matchesGlob('a?c', 'ac'), false);
});

test('write + read roundtrip in tmp dir', async () => {
  const dir = join(tmpdir(), `dae-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const writeTool = tools.find((t) => t.name === 'write')!;
  const readTool = tools.find((t) => t.name === 'read')!;
  await writeTool.execute({ path: join(dir, 'sub', 'f.txt'), content: 'hello' }, makeCtx());
  const r = await readTool.execute({ path: join(dir, 'sub', 'f.txt') }, makeCtx());
  assert.equal(r.content, 'hello');
  rmSync(dir, { recursive: true, force: true });
});

test('edit replaces exact string', async () => {
  const dir = join(tmpdir(), `dae-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'e.txt');
  writeFileSync(file, 'foo bar baz');
  const editTool = tools.find((t) => t.name === 'edit')!;
  await editTool.execute({ path: file, oldString: 'bar', newString: 'QUX' }, makeCtx());
  const readTool = tools.find((t) => t.name === 'read')!;
  const r = await readTool.execute({ path: file }, makeCtx());
  assert.equal(r.content, 'foo QUX baz');
  rmSync(dir, { recursive: true, force: true });
});

test('bash runs command and returns output', async () => {
  const bashTool = tools.find((t) => t.name === 'bash')!;
  const r = await bashTool.execute({ command: 'echo hello' }, makeCtx());
  assert.equal(r.content.trim(), 'hello');
});

test('bash denied by permission returns isError', async () => {
  const bashTool = tools.find((t) => t.name === 'bash')!;
  const r = await bashTool.execute({ command: 'echo hi' }, makeCtx({ askPermission: async () => false }));
  assert.equal(r.isError, true);
});
```

(These use `Date.now()` — fine in tests since tests aren't workflow scripts.)

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/tools/tools.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement types.ts, registry.ts, and the six tools**

`src/tools/types.ts`:
```ts
export interface ToolResult { content: string; isError?: boolean }
export interface ToolContext { cwd: string; askPermission: (action: string, target: string) => Promise<boolean> }
export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute(input: unknown, ctx: ToolContext): Promise<ToolResult>;
}
```

`src/tools/bash.ts`:
```ts
import { spawn } from 'node:child_process';
import type { Tool, ToolContext, ToolResult } from './types.ts';

const BASH_TIMEOUT = 120_000;

export const bashTool: Tool = {
  name: 'bash',
  description: 'Execute a shell command and return its output',
  inputSchema: {
    type: 'object',
    properties: { command: { type: 'string' } },
    required: ['command'],
  },
  async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const command = (input as { command: string }).command;
    const ok = await ctx.askPermission('bash', command);
    if (!ok) return { content: 'Permission denied by user', isError: true };
    return new Promise((resolve) => {
      const child = spawn(command, { shell: true, cwd: ctx.cwd, timeout: BASH_TIMEOUT });
      let stdout = '', stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('error', (e) => resolve({ content: e.message, isError: true }));
      child.on('close', (code) => {
        const out = [stdout, stderr].filter(Boolean).join('\n');
        if (code !== 0) resolve({ content: `exit ${code}\n${out}`, isError: true });
        else resolve({ content: out || '(no output)' });
      });
    });
  },
};
```

`src/tools/read.ts`:
```ts
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { Tool, ToolContext, ToolResult } from './types.ts';

const MAX_BYTES = 1_000_000;

export const readTool: Tool = {
  name: 'read',
  description: 'Read a file, optionally with line offset and limit',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      offset: { type: 'number' },
      limit: { type: 'number' },
    },
    required: ['path'],
  },
  async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { path, offset, limit } = input as { path: string; offset?: number; limit?: number };
    const full = join(ctx.cwd, path);
    const stat = await fs.stat(full);
    if (stat.size > MAX_BYTES && offset === undefined) {
      return { content: `File is ${stat.size} bytes; too large to read whole. Pass offset/limit.`, isError: true };
    }
    const text = await fs.readFile(full, 'utf8');
    const lines = text.split('\n');
    const start = offset ?? 0;
    const end = limit !== undefined ? start + limit : lines.length;
    const sliced = lines.slice(start, end);
    const numbered = sliced.map((l, i) => `${start + i + 1}\t${l}`).join('\n');
    return { content: numbered };
  },
};
```

`src/tools/write.ts`:
```ts
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Tool, ToolContext, ToolResult } from './types.ts';

export const writeTool: Tool = {
  name: 'write',
  description: 'Write content to a file (overwrites after confirmation if it exists)',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' }, content: { type: 'string' } },
    required: ['path', 'content'],
  },
  async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { path, content } = input as { path: string; content: string };
    const full = join(ctx.cwd, path);
    let exists = false;
    try { await fs.access(full); exists = true; } catch { /* not exists */ }
    if (exists) {
      const ok = await ctx.askPermission('write', full);
      if (!ok) return { content: 'Permission denied by user', isError: true };
    }
    await fs.mkdir(dirname(full), { recursive: true });
    await fs.writeFile(full, content, 'utf8');
    return { content: `Wrote ${full}` };
  },
};
```

`src/tools/edit.ts`:
```ts
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { Tool, ToolContext, ToolResult } from './types.ts';

export const editTool: Tool = {
  name: 'edit',
  description: 'Replace an exact string in a file',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' }, oldString: { type: 'string' }, newString: { type: 'string' } },
    required: ['path', 'oldString', 'newString'],
  },
  async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { path, oldString, newString } = input as { path: string; oldString: string; newString: string };
    const full = join(ctx.cwd, path);
    const text = await fs.readFile(full, 'utf8');
    const count = text.split(oldString).length - 1;
    if (count === 0) return { content: `oldString not found in ${full}`, isError: true };
    if (count > 1) return { content: `oldString matches ${count} times; not unique`, isError: true };
    await fs.writeFile(full, text.replace(oldString, newString), 'utf8');
    return { content: `Edited ${full}` };
  },
};
```

`src/tools/ls.ts`:
```ts
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { Tool, ToolContext, ToolResult } from './types.ts';

const IGNORE = new Set(['node_modules', '.git']);

export const lsTool: Tool = {
  name: 'ls',
  description: 'List directory contents',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { path = '.' } = input as { path?: string };
    const full = join(ctx.cwd, path);
    const entries = await fs.readdir(full, { withFileTypes: true });
    const lines = entries
      .filter((e) => !IGNORE.has(e.name))
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
    return { content: lines.join('\n') || '(empty)' };
  },
};
```

`src/tools/grep.ts`:
```ts
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { Tool, ToolContext, ToolResult } from './types.ts';

const IGNORE = new Set(['node_modules', '.git']);

export const grepTool: Tool = {
  name: 'grep',
  description: 'Recursively search file contents for a pattern',
  inputSchema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] },
  async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { pattern, path = '.' } = input as { pattern: string; path?: string };
    const re = new RegExp(pattern);
    const root = join(ctx.cwd, path);
    const out: string[] = [];
    async function walk(dir: string): Promise<void> {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (IGNORE.has(e.name)) continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) { await walk(full); continue; }
        const text = await fs.readFile(full, 'utf8').catch(() => '');
        const lines = text.split('\n');
        lines.forEach((ln, i) => { if (re.test(ln)) out.push(`${full}:${i + 1}:${ln}`); });
      }
    }
    await walk(root);
    return { content: out.join('\n') || '(no matches)' };
  },
};
```

`src/tools/glob.ts`:
```ts
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { Tool, ToolContext, ToolResult } from './types.ts';

const IGNORE = new Set(['node_modules', '.git']);

export function matchesGlob(pattern: string, str: string): boolean {
  const re = new RegExp(
    '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '__GLOBSTAR__')
      .replace(/\*/g, '[^/]*')
      .replace(/__GLOBSTAR__/g, '.*')
      .replace(/\?/g, '[^/]') + '$',
  );
  return re.test(str);
}

export const globTool: Tool = {
  name: 'glob',
  description: 'Find files matching a glob pattern',
  inputSchema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] },
  async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { pattern, path = '.' } = input as { pattern: string; path?: string };
    const root = join(ctx.cwd, path);
    const all: string[] = [];
    async function walk(dir: string, rel: string): Promise<void> {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (IGNORE.has(e.name)) continue;
        const relPath = rel ? `${rel}/${e.name}` : e.name;
        const full = join(dir, e.name);
        if (e.isDirectory()) { await walk(full, relPath); continue; }
        all.push(relPath);
      }
    }
    await walk(root, '');
    const matches = all.filter((f) => matchesGlob(pattern, f));
    return { content: matches.join('\n') || '(no matches)' };
  },
};
```

`src/tools/registry.ts`:
```ts
import { bashTool } from './bash.ts';
import { readTool } from './read.ts';
import { writeTool } from './write.ts';
import { editTool } from './edit.ts';
import { lsTool } from './ls.ts';
import { grepTool } from './grep.ts';
import { globTool } from './glob.ts';
import type { Tool } from './types.ts';

export const tools: Tool[] = [bashTool, readTool, writeTool, editTool, lsTool, grepTool, globTool];
```

- [ ] **Step 4: Run to verify pass + typecheck**

Run: `node --test tests/tools/tools.test.ts`
Expected: PASS.

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add six built-in tools and registry"
```

---

### Task 9: Agent loop + message context

**Files:**
- Create: `src/agent/loop.ts`, `src/agent/context.ts`

**Interfaces:**
- Consumes: `AiClient`, `StreamEvent`, `Message`, `ToolDefinition` from `ai/types.ts`; `Tool`, `ToolContext`, `ToolResult` from `tools/types.ts`; `tools` registry.
- Produces:
  - `class MessageHistory { private msgs: Message[]; add(m: Message): void; get(): Message[]; }` (immutable append; prefix never reorders — spec §6)
  - `function runAgent(params: { client: AiClient; systemPrompt: string; tools: Tool[]; cwd: string; askPermission: (action: string, target: string) => Promise<boolean>; onEvent?: (ev: StreamEvent) => void; maxIterations?: number }): Promise<string>` — returns final assistant text. Runs the loop: call `client.streamChat` with history + tool definitions, feed `onEvent`, accumulate assistant message; if it has `tool_call` blocks, execute each via registry (build `ToolContext` with `cwd` + `askPermission`), append `tool_result` blocks in a user message, repeat. Stop when no tool calls or `maxIterations` (default 100) reached.

- [ ] **Step 1: Write failing tests**

`tests/agent/loop.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from '../../src/agent/loop.ts';
import type { AiClient, StreamEvent, Message } from '../../src/ai/types.ts';
import type { Tool } from '../../src/tools/types.ts';

function echoTool(name: string, input: Record<string, unknown>): Tool {
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
  const result = await runAgent({ client, systemPrompt: 'sys', tools: [], cwd: process.cwd(), askPermission: async () => true });
  assert.equal(result, 'hello');
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
        // second call sees the tool_result in history
        const userMsg = params.messages.find((m) => m.role === 'user');
        assert.ok(userMsg);
        const hasResult = userMsg.content.some((c) => c.type === 'tool_result');
        assert.equal(hasResult, true);
        yield { type: 'text_delta', text: 'done' };
        yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } };
      }
    },
  };
  const tool = echoTool('myTool', {});
  const result = await runAgent({ client, systemPrompt: 'sys', tools: [tool], cwd: process.cwd(), askPermission: async () => true });
  assert.equal(result, 'done');
  assert.equal(iterations, 2);
});

test('stops after maxIterations', async () => {
  let iterations = 0;
  const client: AiClient = {
    async *streamChat() {
      iterations++;
      yield { type: 'done', message: { role: 'assistant', content: [{ type: 'tool_call', id: 't', name: 'myTool', input: {} }] } };
    },
  };
  const tool = echoTool('myTool', {});
  const result = await runAgent({ client, systemPrompt: 'sys', tools: [tool], cwd: process.cwd(), askPermission: async () => true, maxIterations: 2 });
  assert.equal(iterations, 2);
  assert.equal(result, '');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/agent/loop.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement context.ts and loop.ts**

`src/agent/context.ts`:
```ts
import type { Message } from '../ai/types.ts';

export class MessageHistory {
  private msgs: Message[] = [];
  add(m: Message): void { this.msgs.push(m); }
  get(): Message[] { return this.msgs; }
}
```

`src/agent/loop.ts`:
```ts
import type { AiClient, StreamEvent, Message, ToolDefinition } from '../ai/types.ts';
import type { Tool, ToolContext, ToolResult } from '../tools/types.ts';
import { MessageHistory } from './context.ts';

export interface RunAgentParams {
  client: AiClient;
  systemPrompt: string;
  tools: Tool[];
  cwd: string;
  askPermission: (action: string, target: string) => Promise<boolean>;
  onEvent?: (ev: StreamEvent) => void;
  maxIterations?: number;
}

const DEFAULT_MAX = 100;

export async function runAgent(params: RunAgentParams): Promise<string> {
  const history = new MessageHistory();
  history.add({ role: 'system', content: [{ type: 'text', text: params.systemPrompt }] });

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
      // model omitted: client-level default (from config/flags) is applied by the adapter
      messages: history.get(),
      tools: toolDefs,
      cache: { enabled: true },
    })) {
      params.onEvent?.(ev);
      events.push(ev);
      if (ev.type === 'error') throw ev.error;
      if (ev.type === 'done') history.add(ev.message);
    }
    const lastAssistant = events.findLast((e) => e.type === 'done');
    if (!lastAssistant || lastAssistant.type !== 'done') continue;
    const msg = lastAssistant.message;
    finalText = msg.content.filter((c) => c.type === 'text').map((c) => (c.type === 'text' ? c.text : '')).join('');

    const calls = msg.content.filter((c) => c.type === 'tool_call');
    if (calls.length === 0) break;

    const results: ToolResult[] = [];
    const ctx: ToolContext = { cwd: params.cwd, askPermission: params.askPermission };
    for (const call of calls) {
      if (call.type !== 'tool_call') continue;
      const tool = params.tools.find((t) => t.name === call.name);
      let res: ToolResult;
      if (!tool) {
        res = { content: `Unknown tool: ${call.name}`, isError: true };
      } else {
        try { res = await tool.execute(call.input, ctx); }
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
    history.add({ role: 'user', content: resultBlocks });
  }
  return finalText;
}
```

Note: `history.add` on a done message already appends the assistant message; results append a user message with tool_result blocks. The prefix order stays `[system, assistant, user-with-results, assistant, ...]`, immutable and append-only — cache-friendly (spec §5.2/§6).

- [ ] **Step 4: Run to verify pass + typecheck**

Run: `node --test tests/agent/loop.test.ts`
Expected: PASS.

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add agent loop and message history"
```

---

### Task 10: Config loader (minimal working subset)

**Files:**
- Create: `src/config/config.ts`

**Interfaces:**
- Consumes: `AiProviderName`, `AiClientConfig` from `ai/index.ts`.
- Produces:
  - `interface DaedalusConfig { provider: AiProviderName; apiKey: string; baseURL?: string; model?: string; }`
  - `function loadConfig(env: NodeJS.ProcessEnv = process.env): DaedalusConfig` — reads `DAEDALUS_PROVIDER`, `DAEDALUS_API_KEY`/`{OPENAI|ANTHROPIC}_API_KEY`, `DAEDALUS_BASE_URL`, `DAEDALUS_MODEL`; tries `~/.daedalus/config.json` if present. Merge order: defaults → config file → env (spec §8 minimal subset).

- [ ] **Step 1: Write failing tests**

`tests/config/config.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../src/config/config.ts';

test('defaults to anthropic with ANTHROPIC_API_KEY', () => {
  const cfg = loadConfig({ ANTHROPIC_API_KEY: 'sk-ant-1' } as NodeJS.ProcessEnv);
  assert.equal(cfg.provider, 'anthropic');
  assert.equal(cfg.apiKey, 'sk-ant-1');
});

test('DAEDALUS_PROVIDER overrides default', () => {
  const cfg = loadConfig({ DAEDALUS_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-1' } as NodeJS.ProcessEnv);
  assert.equal(cfg.provider, 'openai');
  assert.equal(cfg.apiKey, 'sk-1');
});

test('DAEDALUS_API_KEY takes precedence', () => {
  const cfg = loadConfig({ DAEDALUS_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-env', DAEDALUS_API_KEY: 'sk-dae' } as NodeJS.ProcessEnv);
  assert.equal(cfg.apiKey, 'sk-dae');
});

test('DAEDALUS_MODEL and BASE_URL pass through', () => {
  const cfg = loadConfig({ DAEDALUS_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-1', DAEDALUS_MODEL: 'gpt-4.1', DAEDALUS_BASE_URL: 'http://localhost:11434/v1' } as NodeJS.ProcessEnv);
  assert.equal(cfg.model, 'gpt-4.1');
  assert.equal(cfg.baseURL, 'http://localhost:11434/v1');
});

test('missing key throws helpful error', () => {
  assert.throws(() => loadConfig({} as NodeJS.ProcessEnv), /API key/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/config/config.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement config.ts**

```ts
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AiProviderName } from '../ai/index.ts';

export interface DaedalusConfig {
  provider: AiProviderName;
  apiKey: string;
  baseURL?: string;
  model?: string;
}

interface FileConfig {
  provider?: string;
  apiKey?: string;
  baseURL?: string;
  model?: string;
}

function readFileConfig(): FileConfig {
  try {
    const raw = readFileSync(join(homedir(), '.daedalus', 'config.json'), 'utf8');
    return JSON.parse(raw) as FileConfig;
  } catch {
    return {};
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DaedalusConfig {
  const file = readFileConfig();
  const provider = (env.DAEDALUS_PROVIDER ?? file.provider ?? 'anthropic') as AiProviderName;
  const apiKey = env.DAEDALUS_API_KEY
    ?? (provider === 'openai' ? env.OPENAI_API_KEY : env.ANTHROPIC_API_KEY)
    ?? file.apiKey;
  if (!apiKey) {
    const varName = provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
    throw new Error(`No API key for provider "${provider}". Set ${varName} (or DAEDALUS_API_KEY) or add apiKey to ~/.daedalus/config.json`);
  }
  return {
    provider,
    apiKey,
    baseURL: env.DAEDALUS_BASE_URL ?? file.baseURL,
    model: env.DAEDALUS_MODEL ?? file.model,
  };
}
```

- [ ] **Step 4: Run to verify pass + typecheck**

Run: `node --test tests/config/config.test.ts`
Expected: PASS.

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add minimal config loader"
```

---

### Task 11: REPL CLI + ANSI rendering

**Files:**
- Create: `src/cli/render.ts`, `src/cli/repl.ts`, `src/cli/main.ts`, `src/index.ts` (export public API)

**Interfaces:**
- Consumes: `loadConfig` from `config/config.ts`; `createAiClient` from `ai/index.ts`; `runAgent` from `agent/loop.ts`; `tools` from `tools/registry.ts`.
- Produces:
  - `render.ts`: `const ANSI = { reset:'\x1b[0m', bold:'\x1b[1m', dim:'\x1b[2m', red:'\x1b[31m', green:'\x1b[32m', yellow:'\x1b[33m', blue:'\x1b[34m', gray:'\x1b[90m', italic:'\x1b[3m' }` and `renderEvent(ev: StreamEvent): void` (prints to stdout with colors; tool calls as `bold gray "▶ name: <input>"`, errors in red, text in default).
  - `repl.ts`: `export async function runRepl(opts: { client: ReturnType<typeof createAiClient>; tools: Tool[]; cwd: string; askPermission: (a: string, t: string) => Promise<boolean> }): Promise<void>` — uses `readline/promises`, reads lines, multi-line until blank line or `/run`, `/exit`, `/help`; on prompt, runs `runAgent` and prints final text.
  - `main.ts`: parses `argv` (flags: `--provider`, `--model`, `--base-url`, `--help`); loads config, merges flags, creates client, prints banner, runs REPL.
  - `index.ts`: re-export public API (`createAiClient`, `runAgent`, `tools`, types) for library consumers and `dist` main.

- [ ] **Step 1: Write failing render test**

`tests/cli/render.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderText, renderToolCall } from '../../src/cli/render.ts';

test('renderText wraps in ANSI codes', () => {
  assert.equal(renderText('hi', 'bold'), '\x1b[1mhi\x1b[0m');
});

test('renderToolCall formats name and input', () => {
  const out = renderToolCall({ name: 'bash', input: { command: 'ls' } });
  assert.match(out, /bash/);
  assert.match(out, /ls/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/cli/render.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement render.ts**

`src/cli/render.ts`:
```ts
import type { StreamEvent } from '../ai/types.ts';

export const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  gray: '\x1b[90m',
  italic: '\x1b[3m',
} as const;

export function renderText(text: string, style: keyof typeof ANSI): string {
  return `${ANSI[style]}${text}${ANSI.reset}`;
}

export function renderToolCall(tc: { name: string; input: unknown }): string {
  return `${ANSI.bold}${ANSI.gray}▶ ${tc.name}: ${JSON.stringify(tc.input)}${ANSI.reset}`;
}

export function renderEvent(ev: StreamEvent): void {
  switch (ev.type) {
    case 'text_delta':
      process.stdout.write(ev.text);
      break;
    case 'thinking_delta':
      process.stdout.write(`${ANSI.dim}${ANSI.italic}${ev.thinking}${ANSI.reset}`);
      break;
    case 'tool_call_start':
      process.stdout.write(`\n${renderText(`▶ ${ev.name}`, 'gray')} `);
      break;
    case 'tool_call_delta':
      process.stdout.write(ev.inputDelta);
      break;
    case 'done':
      process.stdout.write('\n');
      break;
    case 'error':
      process.stdout.write(`\n${renderText(`[error] ${ev.error.message}`, 'red')}\n`);
      break;
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test tests/cli/render.test.ts`
Expected: PASS.

- [ ] **Step 5: Implement repl.ts**

`src/cli/repl.ts`:
```ts
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { runAgent } from '../agent/loop.ts';
import type { Tool } from '../tools/types.ts';
import type { AiClient } from '../ai/types.ts';
import { ANSI } from './render.ts';

export interface ReplOpts {
  client: AiClient;
  tools: Tool[];
  cwd: string;
  askPermission: (action: string, target: string) => Promise<boolean>;
}

export async function runRepl(opts: ReplOpts): Promise<void> {
  const rl = readline.createInterface({ input, output, prompt: `${ANSI.green}›${ANSI.reset} ` });
  rl.prompt();
  let buffer = '';
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed === '/exit' || trimmed === '/quit') break;
    if (trimmed === '/help') {
      console.log('Commands: /help, /exit. Type a prompt; blank line submits multi-line input.');
      rl.prompt();
      continue;
    }
    if (trimmed === '/run' || buffer) {
      if (trimmed === '/run' && !buffer) { rl.prompt(); continue; }
      const prompt = buffer ? `${buffer}\n${trimmed === '/run' ? '' : trimmed}` : trimmed;
      buffer = '';
      console.log(ANSI.blue + '— running —' + ANSI.reset);
      try {
        await runAgent({ client: opts.client, systemPrompt: 'You are Daedalus, a terminal agent.', tools: opts.tools, cwd: opts.cwd, askPermission: opts.askPermission });
      } catch (e) {
        console.error(ANSI.red + `error: ${(e as Error).message}` + ANSI.reset);
      }
      console.log();
      rl.prompt();
      continue;
    }
    // accumulating multi-line input
    buffer = trimmed;
    rl.prompt();
  }
  rl.close();
}
```

- [ ] **Step 6: Implement main.ts**

`src/cli/main.ts`:
```ts
#!/usr/bin/env node
import { loadConfig } from '../config/config.ts';
import { createAiClient } from '../ai/index.ts';
import { tools } from '../tools/registry.ts';
import { runRepl } from './repl.ts';
import { ANSI } from './render.ts';

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
await runRepl({ client, tools, cwd: process.cwd(), askPermission });
```

(Import `readline from 'node:readline/promises'` at top of main.ts.)

- [ ] **Step 7: Write index.ts public API**

`src/index.ts`:
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
```

- [ ] **Step 8: Typecheck + full test suite**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 9: Manual smoke run (dev path)**

Run: `node --run dev` — but REPL is interactive; instead verify module load and config error path:
Run: `node src/cli/main.ts --help`
Expected: prints help and exits 0.

Run: `node -e "import('./src/index.ts').then(m => console.log(typeof m.createAiClient))"`
Expected: prints `function`.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: add REPL CLI, ANSI rendering, public API"
```

---

### Task 12: Build output + dist verification

**Files:**
- Modify: `package.json` (add `prepublishOnly` if desired), `src/cli/main.ts` (ensure it works from `dist`)
- Create: none

**Interfaces:**
- Consumes: everything above.
- Produces: a working `dist/` build and a `daedalus` bin that runs from compiled output.

- [ ] **Step 1: Build**

Run: `npm run build`
Expected: `dist/` created with compiled JS + `.d.ts` + source maps.

- [ ] **Step 2: Fix main.ts shebang for dist**

Ensure `src/cli/main.ts` starts with `#!/usr/bin/env node`. Since tsc preserves it, after build check `dist/cli/main.js` retains it. If not, add a `postbuild` script using a tiny node script — but prefer keeping the shebang in source so tsc preserves it (Node strips it from `.ts` but tsc keeps it in output).

Verify: `head -1 dist/cli/main.js` → `#!/usr/bin/env node`.

- [ ] **Step 3: Run from dist**

Run: `node dist/cli/main.js --help`
Expected: prints help, exits 0.

- [ ] **Step 4: Confirm zero runtime deps**

Run: `node -e "const p=require('./package.json'); console.log(JSON.stringify(p.dependencies))"`
Expected: `undefined` or empty — no runtime dependencies (only `typescript` devDependency).

- [ ] **Step 5: Verify no node-gyp anywhere**

Run: `npm ls node-gyp 2>&1 || true`
Expected: prints nothing (or "empty"), confirming no node-gyp in the dependency tree.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: verify dist build and zero-dependency runtime"
```

---

### Task 13: README + final review

**Files:**
- Create: `README.md`
- Modify: none

**Interfaces:**
- Consumes: final product.
- Produces: user-facing documentation.

- [ ] **Step 1: Write README.md**

Cover: what Daedalus is, install (`npm i -g .` or `npx`), config (`~/.daedalus/config.json`, `DAEDALUS_*` env vars, `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`), usage (`daedalus`, flags), tools list, roadmap pointer to spec, the "no node-gyp" dependency policy.

- [ ] **Step 2: Run full suite one more time**

Run: `npm test`
Expected: all green.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "docs: add README"
```

---

## Self-Review

**1. Spec coverage:**
- AI 接入层 (IR, adapters, SSE, http, errors, factory): Tasks 2–7 ✓
- 缓存最大化 (stable prefix, anthropic cache_control, append-only history): Tasks 5, 6, 9 ✓
- Agent 循环 + 消息历史: Task 9 ✓
- 六件套工具: Task 8 ✓
- 权限 (bash y/n 确认; 规则化后置): Tasks 8, 11 ✓
- REPL CLI + ANSI: Task 11 ✓
- 配置 (minimal subset; 详细讨论后置): Task 10 ✓
- 测试计划每项都有对应任务: sse(3), providers(5,6), http(4), tools(8), agent(9) ✓
- 打包/npx: Tasks 1, 12 ✓

**2. Placeholder scan:** No TBD/TODO. All steps contain concrete code. The `tool_call_delta2` in render.ts is a labeled no-op explained inline.

**3. Type consistency:**
- `StreamEvent` variants consistent between types.ts (Task 2) and adapters (Tasks 5, 6) and render.ts (Task 11) ✓
- `ToolResult`/`ToolContext`/`Tool` defined once in Task 8, used in 9 and 11 ✓
- `ChatParams.cache.enabled` used in Tasks 5, 6, 9 ✓
- `AiError` import paths consistent (`errors.ts`) ✓
- `runAgent` params (client/systemPrompt/tools/cwd/askPermission/maxIterations) consistent Task 9 ↔ Task 11 ✓
- main.ts imports `readline` — declared in Step 6 note ✓
- `toAnthropicBody`/`anthropicEventsToIR` (Task 5) and `toOpenAIBody`/`openaiEventsToIR` (Task 6) exported and used in their `create*Client` ✓

**One risk to note:** the OpenAI adapter's `openaiEventsToIR` accumulates text across `content` deltas but OpenAI can interleave a final text chunk after tool call args; the `done` event is only emitted on `finish_reason`, which is the documented safe point. Anthropic's `message_stop` similarly gates `done`. Good.
