# Daedalus Web UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a standalone web UI to daedalus (`daedalus web`) — a native Node http server + vite/solid-js frontend streaming engine `CoreEvent`s over WebSocket, with main chat + subagent views + session management.

**Architecture:** The engine stays UI-agnostic and runs inside the server process; a WebSocket hub mirrors all `CoreEvent`s to the browser with snapshot+replay for refresh/reconnect. The frontend is a solid-js SPA whose pure reducer (`state-model.ts`) turns the event stream into UI state; a thin `stores.ts` wraps it in signals. All server patterns (HttpServer, static serving, vite config, dev script) are copied from `../anther`.

**Tech Stack:** Node 24 (native `node:http`, `ws`, `node:test`), solid-js, vite + vite-plugin-solid. No codemirror/xterm/LSP (explicitly excluded — see spec §12).

**Spec:** `docs/superpowers/specs/2026-08-16-daedalus-web-ui-design.md`

## Global Constraints

Copy these verbatim from the spec; every task inherits them.

- **Zero heavy frameworks.** Only new runtime deps: `solid-js`, `ws`. Only new devDeps: `vite`, `vite-plugin-solid`, `@types/ws`. No codemirror/xterm/LSP (user-confirmed not to introduce, spec §12).
- **Mobile-first, desktop-parity.** One responsive layout; subagents panel is a drawer on narrow screens, inline column on wide (≥1024px).
- **NOT a terminal in the browser.** No PTY/xterm rendering. All content is dialogue + tool cards + status.
- **Engine UI-agnostic, zero engine changes.** All UI needs are served by existing `DaedalusEngine` methods + `SessionStore`. The ONLY storage change is `SessionStore.title` + `rename()` (spec §7.2).
- **Reuse anther patterns verbatim where possible:** `HttpServer` (exact-path routes — no `:id` params, ids go in body), `staticDirFor`, `lanIPv4`, `scripts/dev.mjs`, vite config with `host: true` + `/api` proxy (`ws: true`) to port 3100.
- **Port 3100 default** (`DAEDALUS_WEB_PORT` / `--port` override). Avoids clashing with anther's 3000.
- **Session persistence reuses `SessionStore`** (same `~/.daedalus/sessions` dir, so CLI/TUI/web sessions interoperate).
- **Test: `node:test` only** (no new frameworks). Frontend tests cover PURE logic only (`state-model.ts`, `ws.ts`, `api.ts`) — no jsdom/testing-library.
- **Typescript style:** `.ts` import suffixes, no enums, `erasableSyntaxOnly` (server side). Frontend: `jsx: preserve` + `jsxImportSource: solid-js`, `.tsx` suffix imports.

## File Structure

```
src/
├── server/                      # NEW server package (all under existing src/, tsc handles)
│   ├── http-error.ts            # HttpError + ServerResponse.prototype.json
│   ├── http.ts                  # HttpServer: node:http + exact-path routes + static + ws (from anther)
│   ├── static.ts                # staticDirFor + lanIPv4 (from anther)
│   ├── event-hub.ts             # subagent event tracking: {name, task, status}
│   ├── ws.ts                    # WebSocketHub: snapshot + CoreEvent broadcast + permission round-trip
│   ├── permission.ts            # web askPermission: auto short-circuit + pending map + broadcast
│   ├── server.ts                # assemble config→client→engine→http→ws; run(port)
│   └── routes/
│       ├── chat.ts              # POST /api/chat
│       ├── sessions.ts          # GET/POST/PUT(rename)/POST(delete)
│       ├── agents.ts            # GET /api/agents, /api/agents/messages, POST /api/agents/close
│       ├── config.ts            # GET/PUT /api/config, GET /api/state
│       └── index.ts             # registerAll(http, deps)
├── cli/
│   ├── main.ts                  # MODIFY: dispatch `web` subcommand → server.main
│   ├── flags.ts                 # MODIFY: parse --port
│   └── (tui/repl/render untouched)
└── core/
    └── session-store.ts         # MODIFY: +title field, +rename()
web/
├── index.html
├── tsconfig.json                # web-side tsconfig (jsx preserve + solid, noEmit)
├── vite.config.ts
└── src/
    ├── main.tsx
    ├── App.tsx
    ├── styles.css
    ├── types.ts                 # shared UI-facing types (EventEnvelope, SubagentInfo, etc.)
    ├── state-model.ts           # PURE reducer: CoreEvent → UiState
    ├── ws.ts                    # ws client: connect/reconnect/snapshot/message routing
    ├── api.ts                   # REST wrapper (chat/sessions/agents/config)
    ├── stores.ts                # solid signals wrapping state-model
    ├── routes.ts                # hash router: '' / 'agent/<name>' / 'sessions'
    └── components/
        ├── topbar.tsx
        ├── chat/
        │   ├── message.tsx      # user + assistant text bubbles
        │   ├── stream.tsx       # streaming text
        │   ├── thinking.tsx     # collapsible thinking
        │   ├── tool-card.tsx    # tool call + result card (diff highlight)
        │   ├── delegate-row.tsx # delegate activity row
        │   ├── event-line.tsx   # compact/trim/skill notices
        │   ├── permission-card.tsx
        │   └── input.tsx
        ├── agents/
        │   ├── panel.tsx        # subagent list (wide inline / narrow drawer)
        │   └── detail.tsx       # #/agent/<name> view
        ├── sessions/
        │   └── list.tsx
        └── common/
            ├── badge.tsx        # ● running / ✓ done / ✗ error / ◇ queued
            └── drawer.tsx
scripts/
└── dev.mjs                      # one-shot dev (copy anther)
tests/
├── core/session-store.test.ts   # MODIFY: title/rename tests
├── server/                      # NEW mirrors src/server
│   ├── event-hub.test.ts
│   ├── ws.test.ts
│   ├── permission.test.ts
│   ├── http.test.ts
│   └── routes/ (chat/sessions/agents/config)
└── web/                         # NEW mirrors web/src
    ├── state-model.test.ts
    ├── ws.test.ts
    └── api.test.ts
```

---

### Task 1: Dependencies + frontend scaffold

**Files:**
- Modify: `package.json` (deps + scripts)
- Create: `web/index.html`
- Create: `web/tsconfig.json`
- Create: `web/vite.config.ts`
- Create: `web/src/main.tsx`
- Create: `web/src/App.tsx`
- Create: `web/src/styles.css`
- Create: `scripts/dev.mjs`
- Create: `.gitignore` (append: `web/dist`, `dist`)

**Interfaces:**
- Produces: dev/build/test scripts (`npm run dev`, `dev:web`, `build`, `test` extended), vite dev server on 5173 proxying `/api` (ws) to :3100.

- [ ] **Step 1: Add dependencies**

```bash
npm install solid-js ws
npm install -D vite vite-plugin-solid @types/ws
```

- [ ] **Step 2: Update package.json scripts**

Replace the `scripts` block with:

```json
"scripts": {
  "build": "tsc && vite build --config web/vite.config.ts",
  "dev": "node scripts/dev.mjs",
  "dev:server": "node --watch --experimental-transform-types src/server/server.ts",
  "dev:web": "vite --config web/vite.config.ts",
  "test": "node --test --experimental-transform-types 'tests/**/*.test.ts' 'web/src/**/*.test.ts'",
  "typecheck": "tsc --noEmit && tsc -p web/tsconfig.json"
}
```

- [ ] **Step 3: Create `web/vite.config.ts`** (copy anther's, port 3100 + keep the `os.networkInterfaces` EACCES guard):

```ts
import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';
import path from 'node:path';
import os from 'node:os';

try { os.networkInterfaces(); } catch { os.networkInterfaces = () => ({ lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }] }); }

export default defineConfig({
  root: path.resolve(import.meta.dirname),
  plugins: [solid()],
  server: {
    host: true,
    port: 5173,
    proxy: { '/api': { target: 'http://localhost:3100', ws: true } },
  },
  build: { outDir: path.resolve(import.meta.dirname, '../dist/web'), emptyOutDir: true },
});
```

- [ ] **Step 4: Create `web/tsconfig.json`** (copy anther's):

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "preserve",
    "jsxImportSource": "solid-js",
    "strict": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "skipLibCheck": true,
    "types": []
  },
  "include": ["src"],
  "exclude": ["src/**/*.test.ts"]
}
```

- [ ] **Step 5: Create `web/index.html`** (copy anther's, title "daedalus"):

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover, interactive-widget=resizes-content" />
  <meta name="theme-color" content="#111" />
  <title>daedalus</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/src/main.tsx"></script>
</body>
</html>
```

- [ ] **Step 6: Create `web/src/main.tsx`** (placeholder — real bootstrap wired in Task 12):

```tsx
import { render } from 'solid-js/web';
import { App } from './App.tsx';
import './styles.css';

render(() => <App />, document.getElementById('root')!);
```

- [ ] **Step 7: Create `web/src/App.tsx`** (placeholder shell + responsive breakpoint hook):

```tsx
import { createSignal, onCleanup, Show } from 'solid-js';

const NARROW_QUERY = '(max-width: 1023px)';

export function useIsNarrow(): () => boolean {
  const [narrow, setNarrow] = createSignal(
    typeof window !== 'undefined' && window.matchMedia(NARROW_QUERY).matches,
  );
  if (typeof window !== 'undefined') {
    const mq = window.matchMedia(NARROW_QUERY);
    const onChange = () => setNarrow(mq.matches);
    mq.addEventListener('change', onChange);
    onCleanup(() => mq.removeEventListener('change', onChange));
  }
  return narrow;
}

export function App() {
  return <div class="app">daedalus web — scaffold</div>;
}
```

- [ ] **Step 8: Create `web/src/styles.css`** — minimal reset + app frame (detailed styles land per-task):

```css
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: #111; color: #e5e5e5; font-family: system-ui, sans-serif; }
#root { height: 100%; }
.app { height: 100%; display: flex; flex-direction: column; }
```

- [ ] **Step 9: Create `scripts/dev.mjs`** (copy anther's verbatim; backend points at `src/server/server.ts`):

```js
#!/usr/bin/env node
// 一键开发模式：后端（node --watch）+ 前端（vite）同终端启动（仿 anther）。
import { spawn } from 'node:child_process';
const backendArgs = process.argv.slice(2);
const frontendArgs = ['node_modules/vite/bin/vite.js', '--config', 'web/vite.config.ts'];
const children = [];
let shuttingDown = false;
function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) { try { process.kill(-c.pid, 'SIGTERM'); } catch {} }
  setTimeout(() => process.exit(code), 500);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('SIGHUP', () => shutdown(0));
function start(label, args) {
  const c = spawn(process.execPath, args, { stdio: 'inherit', detached: true });
  c.on('exit', (code) => {
    if (!shuttingDown && code !== 0) { console.error(`[dev] ${label} 退出（code ${code}），联动关闭另一进程`); shutdown(code ?? 1); }
  });
  children.push(c);
  return c;
}
start('backend', ['--watch', '--experimental-transform-types', 'src/server/server.ts', ...backendArgs]);
start('frontend', frontendArgs);
```

- [ ] **Step 10: Verify scaffold builds**

Run: `npm run typecheck`
Expected: tsc (root) passes; `tsc -p web/tsconfig.json` passes with no errors.

- [ ] **Step 11: Commit**

```bash
git add package.json package-lock.json web/ scripts/dev.mjs .gitignore
git commit -m "chore(web): vite + solid-js scaffold, dev/build/test scripts"
```

---

### Task 2: SessionStore title + rename

**Files:**
- Modify: `src/core/session-store.ts`
- Test: `tests/core/session-store.test.ts`

**Interfaces:**
- Consumes: existing `SessionStore.save(state, meta)`, `load(id)`, `list()`, `remove(id)`.
- Produces:
  - `SessionMeta` gains `title: string`
  - `StoredSession` gains `title?: string`
  - `save()` writes a default `title` from the first user message (≤80 chars), truncated with `…`; keeps existing `title` on subsequent saves
  - `rename(id: string, title: string): Promise<void>` — rewrites the file's `title`
  - `list()` reads `p.title ?? titleFromMessages(p.messages) ?? '未命名会话'`

- [ ] **Step 1: Write the failing tests** (append to `tests/core/session-store.test.ts`):

```ts
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// — title/rename tests (append to existing file) —

test('save() derives a title from the first user message', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dae-ss-title-'));
  const store = new SessionStore(dir);
  const id = await store.save({ messages: [
    { role: 'user', content: [{ type: 'text', text: 'Refactor the parser to async' }] },
  ], loadedSkills: [] });
  const meta = (await store.list())[0];
  assert.equal(meta.title, 'Refactor the parser to async');
});

test('save() truncates long titles to 80 chars with ellipsis', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dae-ss-trunc-'));
  const store = new SessionStore(dir);
  const long = 'x'.repeat(100);
  await store.save({ messages: [{ role: 'user', content: [{ type: 'text', text: long }] }], loadedSkills: [] });
  const meta = (await store.list())[0];
  assert.equal(meta.title, 'x'.repeat(79) + '…');
});

test('save() keeps an existing title across saves', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dae-ss-keep-'));
  const store = new SessionStore(dir);
  const id = await store.save({ messages: [{ role: 'user', content: [{ type: 'text', text: 'first' }] }], loadedSkills: [] });
  await store.save({ messages: [
    { role: 'user', content: [{ type: 'text', text: 'second message' }] },
  ], loadedSkills: [] }, { id });
  const meta = (await store.list())[0];
  assert.equal(meta.title, 'first');
});

test('rename() rewrites the stored title', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dae-ss-ren-'));
  const store = new SessionStore(dir);
  const id = await store.save({ messages: [{ role: 'user', content: [{ type: 'text', text: 'first' }] }], loadedSkills: [] });
  await store.rename(id, 'Renamed');
  const raw = JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8'));
  assert.equal(raw.title, 'Renamed');
  assert.equal((await store.list())[0].title, 'Renamed');
});

test('rename() throws on a missing session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dae-ss-renx-'));
  const store = new SessionStore(dir);
  await assert.rejects(() => store.rename('does-not-exist', 'x'), /Session not found/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test --experimental-transform-types tests/core/session-store.test.ts`
Expected: 5 failures (no `title` on `SessionMeta`; `rename` is not a function).

- [ ] **Step 3: Implement `title` in `SessionStore`**

In `src/core/session-store.ts`:

- `SessionMeta`: add `title: string`
- `StoredSession`: add `title?: string`

```ts
function titleFromMessages(messages: SessionState['messages']): string | undefined {
  for (const m of messages) {
    if (m.role !== 'user') continue;
    for (const c of m.content) {
      if (c.type === 'text' && c.text.trim()) {
        const t = c.text.trim().replace(/\s+/g, ' ');
        return t.length > 80 ? `${t.slice(0, 79)}…` : t;
      }
    }
  }
  return undefined;
}
```

In `save()`, compute and persist `title`:

```ts
const payload: StoredSession = {
  id,
  createdAt: existing?.createdAt ?? now,
  updatedAt: now,
  cwd: meta.cwd ?? existing?.cwd,
  title: existing?.title ?? titleFromMessages(state.messages),
  messages: state.messages,
  loadedSkills: state.loadedSkills,
};
```

In `list()`, read the title with fallback:

```ts
metas.push({
  id,
  updatedAt: p.updatedAt ?? '',
  title: (typeof p.title === 'string' && p.title) || titleFromMessages(Array.isArray(p.messages) ? p.messages : []) || '未命名会话',
  messageCount: Array.isArray(p.messages) ? p.messages.length : 0,
});
```

- [ ] **Step 4: Implement `rename()`**

```ts
/** Rename a stored session; throws on a missing/corrupt file. */
async rename(id: string, title: string): Promise<void> {
  const existing = await this.load(id);
  existing.title = title;
  const tmp = this.file(`${id}.tmp`);
  await writeFile(tmp, JSON.stringify(existing, null, 2));
  await rename(tmp, this.file(id));
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test --experimental-transform-types tests/core/session-store.test.ts`
Expected: all tests pass (existing + new).

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck` — expected clean.
Commit:

```bash
git add src/core/session-store.ts tests/core/session-store.test.ts
git commit -m "feat(core): SessionStore title + rename for web session list"
```

---

### Task 3: HttpServer + http-error (from anther)

**Files:**
- Create: `src/server/http-error.ts`
- Create: `src/server/http.ts`
- Test: `tests/server/http.test.ts`

**Interfaces:**
- Consumes: nothing (standalone).
- Produces:
  - `export class HttpError extends Error { constructor(public status: number, message: string) }`
  - `ServerResponse.prototype.json(data: unknown, status?: number): void` (module augmentation)
  - `export class HttpServer { constructor(opts: { staticDir: string }); get/put/post(pattern, handler); ws(pattern, wsHandler); sse(pattern, sseHandler); listen(port, host): Promise<void>; close(): Promise<void>; address() }`
  - Handler types: `Handler = (req, body: unknown, query: URLSearchParams) => Promise<unknown> | unknown`; `WsHandler = (ws: WebSocket, req, query) => void | Promise<void>`

Copy `server/http.ts` + `server/http-error.ts` from anther verbatim, BUT drop the SSE branch (daedalus uses ws only) — keep the static + SPA-fallback + ws paths. Import paths change to `.ts`.

- [ ] **Step 1: Write the failing test** (`tests/server/http.test.ts`):

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetch as netFetch } from 'node:http'; // node:http has no fetch; use global fetch to http://localhost
import { HttpServer } from '../../src/server/http.ts';

async function withServer(t, setup, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dae-http-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>dae</title>');
  writeFileSync(join(dir, 'app.js'), 'console.log(1)');
  const http = new HttpServer({ staticDir: dir });
  setup(http);
  await http.listen(0, '127.0.0.1');
  const { port } = http.address() as { port: number };
  const base = `http://127.0.0.1:${port}`;
  try { await fn(base); } finally { await http.close(); }
}

test('route handlers return JSON with res.json', async () => {
  await withServer(t, (h) => {
    h.get('/api/hello', () => ({ hi: 'there' }));
  }, async (base) => {
    const res = await fetch(`${base}/api/hello`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { hi: 'there' });
  });
});

test('unknown /api route -> 404 JSON', async () => {
  await withServer(t, () => {}, async (base) => {
    const res = await fetch(`${base}/api/nope`);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'not found' });
  });
});

test('static files served + SPA fallback to index.html', async () => {
  await withServer(t, () => {}, async (base) => {
    const js = await fetch(`${base}/app.js`);
    assert.equal(js.status, 200);
    assert.equal(await js.text(), 'console.log(1)');
    const spa = await fetch(`${base}/some/deep/path`);
    assert.equal(spa.status, 200);
    assert.match(await spa.text(), /dae/);
  });
});

test('request body is JSON-parsed with 1MB cap', async () => {
  await withServer(t, (h) => {
    h.post('/api/echo', (req, body) => ({ body }));
  }, async (base) => {
    const ok = await fetch(`${base}/api/echo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ a: 1 }) });
    assert.deepEqual(await ok.json(), { body: { a: 1 } });
    const tooBig = await fetch(`${base}/api/echo`, { method: 'POST', body: JSON.stringify({ big: 'x'.repeat(2_000_000) }) });
    assert.equal(tooBig.status, 413);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --experimental-transform-types tests/server/http.test.ts`
Expected: `ERR_MODULE_NOT_FOUND` (no `src/server/http.ts`).

- [ ] **Step 3: Create `src/server/http-error.ts`** (copy anther verbatim; `.ts` imports):

```ts
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

import { ServerResponse } from 'node:http';
declare module 'node:http' {
  interface ServerResponse {
    json(data: unknown, status?: number): void;
  }
}
ServerResponse.prototype.json = function (data: unknown, status = 200) {
  const body = JSON.stringify(data);
  this.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  this.end(body);
};
```

- [ ] **Step 4: Create `src/server/http.ts`** — copy anther's, removing the SSE branch. Core (keep exactly):

```ts
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { HttpError } from './http-error.ts';

export type Handler = (req, body: unknown, query: URLSearchParams) => Promise<unknown> | unknown;
export type WsHandler = (ws: WebSocket, req, query: URLSearchParams) => void | Promise<void>;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
};

export class HttpServer {
  private routes = new Map<string, Map<string, Handler>>();
  private wsRoutes = new Map<string, WsHandler>();
  private wss = new WebSocketServer({ noServer: true });
  private server = createServer((req, res) => void this.handle(req, res));
  private staticDir: string;

  constructor(opts: { staticDir: string }) {
    this.staticDir = opts.staticDir;
    this.wss.on('connection', async (ws, req) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const h = this.wsRoutes.get(url.pathname);
      try { if (h) await h(ws, req, url.searchParams); else ws.close(); }
      catch (e) { console.error(`ws handler ${url.pathname}:`, e); ws.close(); }
    });
    this.server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (!this.wsRoutes.has(url.pathname)) { socket.destroy(); return; }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req));
    });
  }
  get(pattern: string, h: Handler) { this.add('GET', pattern, h); }
  put(pattern: string, h: Handler) { this.add('PUT', pattern, h); }
  post(pattern: string, h: Handler) { this.add('POST', pattern, h); }
  ws(pattern: string, h: WsHandler) { this.wsRoutes.set(pattern, h); }
  private add(method: string, pattern: string, h: Handler) {
    if (!this.routes.has(method)) this.routes.set(method, new Map());
    this.routes.get(method)!.set(pattern, h);
  }
  async listen(port: number, host: string) {
    return new Promise<void>((resolve) => this.server.listen(port, host, resolve));
  }
  close() {
    for (const c of this.wss.clients) c.close();
    this.wss.close();
    return new Promise<void>((resolve, reject) =>
      this.server.close((e) => (e ? reject(e) : resolve())),
    );
  }
  address() { return this.server.address(); }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if ((req.method === 'GET' || req.method === 'HEAD') && !url.pathname.startsWith('/api/')) {
        await this.serveStatic(url.pathname, res, req.method === 'HEAD');
        return;
      }
      const handler = this.routes.get(req.method ?? '')?.get(url.pathname);
      if (!handler) throw new HttpError(404, 'not found');
      const body = await readBody(req);
      const result = await handler(req, body, url.searchParams);
      res.json(result ?? { ok: true });
    } catch (e: unknown) {
      if (e instanceof HttpError) res.json({ error: e.message }, e.status);
      else res.json({ error: 'internal error' }, 500);
    }
  }

  /** 静态资源 + SPA fallback（同 anther）。 */
  private async serveStatic(urlPath: string, res: ServerResponse, headOnly = false) {
    let rel: string;
    try { rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath.slice(1)); }
    catch { throw new HttpError(400, 'bad path'); }
    const abs = path.resolve(this.staticDir, rel);
    if (!abs.startsWith(path.resolve(this.staticDir) + path.sep) && rel !== 'index.html') {
      throw new HttpError(400, 'bad path');
    }
    let content: Buffer; let ext: string;
    try { content = await readFile(abs); ext = path.extname(abs); }
    catch { content = await readFile(path.join(this.staticDir, 'index.html')); ext = '.html'; }
    res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream', 'Content-Length': content.length });
    res.end(headOnly ? undefined : content);
  }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1_000_000) throw new HttpError(413, 'body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return undefined;
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'invalid JSON'); }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test --experimental-transform-types tests/server/http.test.ts`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/server/http-error.ts src/server/http.ts tests/server/http.test.ts
git commit -m "feat(server): HttpServer from anther (exact-path routes, static+SPA, ws)"
```

---

### Task 4: EventHub (subagent tracking)

**Files:**
- Create: `src/server/event-hub.ts`
- Test: `tests/server/event-hub.test.ts`

**Interfaces:**
- Consumes: `CoreEvent` (`src/core/events.ts`).
- Produces:
  - `export interface SubagentTracked { name: string; task: string; status: 'running' | 'done' | 'error'; messageCount: number; loadedSkills: string[] }`
  - `export class EventHub { constructor(); handle(ev: CoreEvent): void; list(): SubagentTracked[]; reset(): void }`
  - `handle` consumes events (call from the ws hub for every engine event with `ev.agent`), tracking each agent's current task + running state.
  - `list()` returns agents in the order they first appeared.

- [ ] **Step 1: Write the failing test** (`tests/server/event-hub.test.ts`):

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventHub } from '../../src/server/event-hub.ts';
import type { CoreEvent } from '../../src/core/events.ts';

function ev(partial: Partial<CoreEvent> & { type: CoreEvent['type'] }): CoreEvent {
  return partial as CoreEvent;
}

test('tracks task from delegate_start and status transitions', () => {
  const hub = new EventHub();
  hub.handle(ev({ type: 'delegate_start', agent: 'researcher', task: 'find the bug' }));
  assert.deepEqual(hub.list(), [
    { name: 'researcher', task: 'find the bug', status: 'running', messageCount: 0, loadedSkills: [] },
  ]);
  hub.handle(ev({ type: 'done', agent: 'researcher', message: { role: 'assistant', content: [] } }));
  assert.equal(hub.list()[0].status, 'done');
});

test('untagged events are ignored', () => {
  const hub = new EventHub();
  hub.handle(ev({ type: 'delegate_start', task: 'x' }));
  assert.equal(hub.list().length, 0);
});

test('agents appear in first-seen order; repeated delegates keep one row', () => {
  const hub = new EventHub();
  hub.handle(ev({ type: 'delegate_start', agent: 'a', task: '1' }));
  hub.handle(ev({ type: 'delegate_start', agent: 'b', task: '2' }));
  hub.handle(ev({ type: 'delegate_start', agent: 'a', task: '3' }));
  assert.deepEqual(hub.list().map((a) => a.name), ['a', 'b']);
  assert.equal(hub.list()[0].task, '3');
});

test('reset clears all agents', () => {
  const hub = new EventHub();
  hub.handle(ev({ type: 'delegate_start', agent: 'a', task: '1' }));
  hub.reset();
  assert.deepEqual(hub.list(), []);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --experimental-transform-types tests/server/event-hub.test.ts`
Expected: `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement `src/server/event-hub.ts`**

```ts
import type { CoreEvent } from '../core/events.ts';

export interface SubagentTracked {
  name: string;
  task: string;
  status: 'running' | 'done' | 'error';
  messageCount: number;
  loadedSkills: string[];
}

/** 跟踪 subagent 活动（名字/当前任务/运行状态），供 ws 快照与 /api/agents 消费。 */
export class EventHub {
  private byName = new Map<string, SubagentTracked>();
  private order: string[] = [];

  handle(ev: CoreEvent): void {
    if (ev.agent === undefined) return;
    let t = this.byName.get(ev.agent);
    if (!t) {
      t = { name: ev.agent, task: '', status: 'running', messageCount: 0, loadedSkills: [] };
      this.byName.set(ev.agent, t);
      this.order.push(ev.agent);
    }
    switch (ev.type) {
      case 'delegate_start':
        t.task = ev.task ?? '';
        t.status = 'running';
        break;
      case 'done':
        t.status = 'done';
        break;
      case 'error':
        t.status = 'error';
        break;
    }
  }

  /** 按首次出现顺序返回当前全部 agent（含 running/done/error 状态）。 */
  list(): SubagentTracked[] {
    return this.order.map((name) => this.byName.get(name)!);
  }

  reset(): void {
    this.byName.clear();
    this.order = [];
  }
}
```

- [ ] **Step 4: Run tests + typecheck + commit**

Run: `node --test --experimental-transform-types tests/server/event-hub.test.ts`
Expected: pass.
Commit:

```bash
git add src/server/event-hub.ts tests/server/event-hub.test.ts
git commit -m "feat(server): EventHub tracks subagent task/status for web views"
```

---

### Task 5: WebSocketHub (snapshot + broadcast + permission)

**Files:**
- Create: `src/server/ws.ts`
- Test: `tests/server/ws.test.ts`

**Interfaces:**
- Consumes: `CoreEvent`, `EventHub`, `WebSocket` (from `ws`), `DaedalusEngine` (via injected getters), `WebPermissionManager` (Task 6).
- Produces:
  - `export interface SnapshotPayload { messages: unknown[]; subagents: SubagentTracked[]; running: boolean; log: CoreEvent[]; pendingPermission: { id: string; action: string; target: string } | null }`
  - `export class WebSocketHub { constructor(opts: { engine: Pick<DaedalusEngine,'getSessionState'|'listSubagents'|'getSubagentMessages'>; hub: EventHub; permission: WebPermissionManager }); attach(http: HttpServer): void; broadcastEvent(ev: CoreEvent): void }`
  - On connection (`/api/ws`): sends `snapshot` then replays `log` as `event` messages; `broadcastEvent` fans out to all clients; forwards `permission` messages to the permission manager.

- [ ] **Step 1: Write the failing test** (`tests/server/ws.test.ts`) — drive a real `WebSocket` client:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { HttpServer } from '../../src/server/http.ts';
import { WebSocketHub } from '../../src/server/ws.ts';
import { EventHub } from '../../src/server/event-hub.ts';
import { WebPermissionManager } from '../../src/server/permission.ts';

function wsBase(): string {
  const http = new HttpServer({ staticDir: process.cwd() }); // static unused
  return http;
}
// NOTE: attach a hub to a fresh HttpServer per test; helper below.

async function connect(hub: WebSocketHub, http: HttpServer): Promise<WebSocket> {
  await http.listen(0, '127.0.0.1');
  const { port } = http.address() as { port: number };
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function fakeEngine() {
  return {
    getSessionState: () => ({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], loadedSkills: [] }),
    listSubagents: () => [],
    getSubagentMessages: () => [],
  };
}

test('sends snapshot on connect with current messages + subagents + running', async () => {
  const http = new HttpServer({ staticDir: process.cwd() });
  const hub = new WebSocketHub({ engine: fakeEngine() as any, hub: new EventHub(), permission: new WebPermissionManager() });
  hub.attach(http);
  const ws = await connect(hub, http);
  const msg = JSON.parse(await new Promise((res, rej) => { ws.on('message', (d) => res(d.toString())); ws.on('error', rej); setTimeout(() => rej(new Error('timeout')), 1000); })) as any;
  assert.equal(msg.type, 'snapshot');
  assert.equal(msg.messages.length, 1);
  assert.equal(msg.running, false);
  ws.close();
  await http.close();
});

test('broadcasts engine events as event messages to clients', async () => {
  const http = new HttpServer({ staticDir: process.cwd() });
  const hub = new WebSocketHub({ engine: fakeEngine() as any, hub: new EventHub(), permission: new WebPermissionManager() });
  hub.attach(http);
  const ws = await connect(hub, http);
  // consume snapshot
  await new Promise((res) => ws.on('message', res));
  hub.broadcastEvent({ type: 'text_delta', text: 'hello' });
  const msg = JSON.parse(await new Promise((res, rej) => { ws.on('message', (d) => res(d.toString())); setTimeout(() => rej(new Error('timeout')), 1000); })) as any;
  assert.equal(msg.type, 'event');
  assert.equal(msg.ev.text, 'hello');
  ws.close();
  await http.close();
});

test('replays in-flight log events after snapshot', async () => {
  const http = new HttpServer({ staticDir: process.cwd() });
  const hub = new WebSocketHub({ engine: fakeEngine() as any, hub: new EventHub(), permission: new WebPermissionManager() });
  hub.broadcastEvent({ type: 'tool_call_start', id: '1', name: 'bash' }); // mark in-flight log before any client
  hub.attach(http);
  const ws = await connect(hub, http);
  const first = JSON.parse(await new Promise((res) => ws.on('message', res))) as any;
  assert.equal(first.type, 'snapshot');
  assert.equal(first.running, true);
  assert.equal(first.log.length, 1);
  const replayed = JSON.parse(await new Promise((res) => ws.on('message', res))) as any;
  assert.equal(replayed.type, 'event');
  assert.equal(replayed.ev.name, 'bash');
  ws.close();
  await http.close();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --experimental-transform-types tests/server/ws.test.ts`
Expected: `ERR_MODULE_NOT_FOUND` (no `ws.ts` / `permission.ts`).

- [ ] **Step 3: Implement `src/server/ws.ts`**

```ts
import type { HttpServer } from './http.ts';
import type { CoreEvent } from '../core/events.ts';
import type { EventHub, SubagentTracked } from './event-hub.ts';
import type { DaedalusEngine } from '../core/engine.ts';
import type { WebPermissionManager } from './permission.ts';

export interface SnapshotPayload {
  messages: unknown[];
  subagents: SubagentTracked[];
  running: boolean;
  log: CoreEvent[];
  pendingPermission: { id: string; action: string; target: string } | null;
}

/** 终止本轮的事件：收到后清空 in-flight 日志，并撤下全部挂起权限。 */
const TERMINALS: ReadonlySet<CoreEvent['type']> = new Set(['done', 'error']);

/** WebSocket 枢纽：连接即发快照；广播全部 CoreEvent；权限请求/响应转发。 */
export class WebSocketHub {
  private engine: Pick<DaedalusEngine, 'getSessionState' | 'listSubagents' | 'getSubagentMessages'>;
  private hub: EventHub;
  private permission: WebPermissionManager;
  private log: CoreEvent[] = [];
  private clients = new Set<import('ws').WebSocket>();

  constructor(opts: {
    engine: Pick<DaedalusEngine, 'getSessionState' | 'listSubagents' | 'getSubagentMessages'>;
    hub: EventHub;
    permission: WebPermissionManager;
  }) {
    this.engine = opts.engine;
    this.hub = opts.hub;
    this.permission = opts.permission;
  }

  attach(http: HttpServer): void {
    http.ws('/api/ws', (ws) => {
      this.clients.add(ws);
      ws.send(JSON.stringify({ type: 'snapshot', ...this.snapshot() }));
      for (const ev of this.log) this.sendEvent(ws, ev);
      ws.on('message', (raw) => {
        let msg: { type?: string; id?: string; allow?: boolean; always?: boolean };
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg.type === 'permission' && typeof msg.id === 'string' && typeof msg.allow === 'boolean') {
          this.permission.settle(msg.id, msg.allow, msg.always === true);
        }
      });
      ws.on('close', () => this.clients.delete(ws));
    });
  }

  private snapshot(): SnapshotPayload {
    const running = !TERMINALS.has(this.log[this.log.length - 1]?.type ?? 'done');
    return {
      messages: this.engine.getSessionState().messages,
      subagents: this.hub.list(),
      running,
      log: [...this.log],
      pendingPermission: this.permission.pending(),
    };
  }

  private sendEvent(ws: import('ws').WebSocket, ev: CoreEvent): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'event', ev }));
  }

  /** 向所有客户端广播任意消息（权限请求等非 CoreEvent 消息）。 */
  broadcast(msg: unknown): void {
    const raw = JSON.stringify(msg);
    for (const c of this.clients) if (c.readyState === c.OPEN) c.send(raw);
  }

  broadcastEvent(ev: CoreEvent): void {
    this.hub.handle(ev);
    if (TERMINALS.has(ev.type)) {
      this.log = [];
      this.permission.clearAll();
    } else {
      this.log.push(ev);
    }
    for (const c of this.clients) this.sendEvent(c, ev);
  }
}
```

- [ ] **Step 4: Create `src/server/permission.ts`** (needed by the ws test):

```ts
import type { DaedalusEngine } from '../core/engine.ts';

export interface PendingPermission { id: string; action: string; target: string }

/** Web 权限审批：auto 短路；普通模式挂起等待 ws 响应。 */
export class WebPermissionManager {
  private pendingMap = new Map<string, PendingPermission & { resolve: (allow: boolean) => void }>();
  private seq = 0;
  private broadcast: (msg: unknown) => void = () => {};
  private engine: Pick<DaedalusEngine, 'getAutoApprove' | 'setAutoApprove'>;

  constructor(engine: Pick<DaedalusEngine, 'getAutoApprove' | 'setAutoApprove'> = { getAutoApprove: () => false, setAutoApprove: () => {} }) {
    this.engine = engine;
  }

  /** ws 层设置广播：把新挂起权限推给前端。 */
  setBroadcast(fn: (msg: unknown) => void): void { this.broadcast = fn; }

  /** 作为 engine.setAskPermission 的处理器安装。 */
  ask = (action: string, target: string): Promise<boolean> => {
    if (this.engine.getAutoApprove()) return Promise.resolve(true); // auto 模式全自动
    const id = `p${++this.seq}`;
    return new Promise<boolean>((resolve) => {
      this.pendingMap.set(id, { id, action, target, resolve });
      this.broadcast({ type: 'permission', id, action, target });
    });
  };

  /** ws 收到前端审批结果：always → 本轮始终允许；随后 resolve。 */
  settle(id: string, allow: boolean, always: boolean): void {
    if (always) this.engine.setAutoApprove(true);
    const entry = this.pendingMap.get(id);
    if (entry) { this.pendingMap.delete(id); entry.resolve(allow); }
  }

  /** 当前挂起权限（快照用；首项即可，工具调用串行审批）。 */
  pending(): PendingPermission | null {
    const first = this.pendingMap.values().next().value as (PendingPermission & { resolve: (allow: boolean) => void }) | undefined;
    return first ? { id: first.id, action: first.action, target: first.target } : null;
  }

  /** 本轮结束/错误时撤下全部挂起权限（拒绝），防止幽灵卡片。 */
  clearAll(): void {
    for (const entry of this.pendingMap.values()) entry.resolve(false);
    this.pendingMap.clear();
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test --experimental-transform-types tests/server/ws.test.ts`
Expected: pass.

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck`
Commit:

```bash
git add src/server/ws.ts src/server/permission.ts tests/server/ws.test.ts
git commit -m "feat(server): WebSocketHub snapshot+broadcast, WebPermissionManager"
```

---

### Task 6: Routes (chat / sessions / agents / config / state)

**Files:**
- Create: `src/server/routes/chat.ts`
- Create: `src/server/routes/sessions.ts`
- Create: `src/server/routes/agents.ts`
- Create: `src/server/routes/config.ts`
- Create: `src/server/routes/index.ts`
- Test: `tests/server/routes.test.ts`

**Interfaces:**
- Consumes: `HttpServer`, `HttpError`, `DaedalusEngine` (methods `run`/`getSessionState`/`listSessions`/`resume`/`clearConversation`/`listSubagents`/`getSubagentMessages`/`closeSubagent`/`getModel`/`setModel`/`getAutoApprove`/`setAutoApprove`/`getPlanMode`/`setPlanMode`/`usage`), `SessionStore` (methods `list`/`load`/`remove`/`rename`), `WebSocketHub`.
- Produces:
  - `registerChatRoutes(http, engine, hub): void` — `POST /api/chat`
  - `registerSessionRoutes(http, engine, store): void` — `GET/POST /api/sessions`, `PUT /api/sessions/rename`, `POST /api/sessions/delete`
  - `registerAgentRoutes(http, engine): void` — `GET /api/agents`, `GET /api/agents/messages?name=`, `POST /api/agents/close`
  - `registerConfigRoutes(http, engine): void` — `GET/PUT /api/config`, `GET /api/state`
  - `registerAll(http, deps): void`

- [ ] **Step 1: Write the failing tests** (`tests/server/routes.test.ts`) using a fake engine + fake SessionStore (no real AI needed):

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpServer } from '../../src/server/http.ts';
import { registerAll } from '../../src/server/routes/index.ts';
import type { DaedalusEngine } from '../../src/core/engine.ts';
import type { SessionMeta } from '../../src/core/session-store.ts';
import type { WebSocketHub } from '../../src/server/ws.ts';
import type { EventHub } from '../../src/server/event-hub.ts';
import type { WebPermissionManager } from '../../src/server/permission.ts';

function fakeEngine(over: Partial<{
  runResult: string; runError: Error; sessions: SessionMeta[]; autoApprove: boolean;
}> = {}): DaedalusEngine {
  let running = false;
  return {
    run: async (prompt: string) => {
      if (running) throw Object.assign(new Error('already running'), { status: 409 });
      running = true;
      await new Promise((r) => setTimeout(r, 1));
      running = false;
      if (over.runError) throw over.runError;
      return over.runResult ?? `ok:${prompt}`;
    },
    getSessionState: () => ({ messages: [], loadedSkills: [] }),
    listSessions: async () => over.sessions ?? [],
    resume: async () => ({ id: 's1', updatedAt: '', messageCount: 0 }),
    clearConversation: () => 0,
    listSubagents: () => [],
    getSubagentMessages: () => [],
    closeSubagent: () => {},
    getModel: () => 'm', setModel: () => {},
    getAutoApprove: () => over.autoApprove ?? false, setAutoApprove: () => {},
    getPlanMode: () => false, setPlanMode: () => {},
    usage: () => ({ inputTokens: 0, outputTokens: 0 }),
  } as unknown as DaedalusEngine;
}

function fakeStore(over: { sessions?: SessionMeta[] } = {}) {
  return {
    list: async () => over.sessions ?? [],
    load: async () => ({ id: 's1', messages: [], loadedSkills: [] }),
    remove: async () => {},
    rename: async () => {},
  };
}

async function withRoutes(t, engine, store, hub, fn) {
  const http = new HttpServer({ staticDir: process.cwd() });
  registerAll(http, { engine: engine as any, store: store as any, hub: hub as any });
  await http.listen(0, '127.0.0.1');
  const { port } = http.address() as { port: number };
  const base = `http://127.0.0.1:${port}`;
  try { await fn(base); } finally { await http.close(); }
}

test('POST /api/chat runs the engine and returns the result', async () => {
  const engine = fakeEngine();
  await withRoutes(t, engine, fakeStore(), {}, async (base) => {
    const res = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'hi' }) });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'ok', result: 'ok:hi' });
  });
});

test('POST /api/chat returns 409 while a run is in flight', async () => {
  let running = true;
  const engine = fakeEngine({});
  // make run() stay in-flight via a never-resolving prompt
  engine.run = () => new Promise(() => {}) as any;
  await withRoutes(t, engine, fakeStore(), {}, async (base) => {
    const first = fetch(`${base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'a' }) });
    const second = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'b' }) });
    assert.equal(second.status, 409);
    // abort the first so the server can close
    (await first) as Response; // keeps the promise alive for test teardown
  });
});

test('GET /api/sessions returns titles from the store', async () => {
  const store = fakeStore({ sessions: [{ id: 's1', updatedAt: '2026-01-01', title: 'Hello', messageCount: 3 }] });
  await withRoutes(t, fakeEngine(), store, {}, async (base) => {
    const res = await fetch(`${base}/api/sessions`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.sessions[0].title, 'Hello');
  });
});

test('PUT /api/sessions/rename calls store.rename with id+title', async () => {
  let renamed: { id: string; title: string } | null = null;
  const store = fakeStore();
  store.rename = async (id: string, title: string) => { renamed = { id, title }; };
  await withRoutes(t, fakeEngine(), store, {}, async (base) => {
    const res = await fetch(`${base}/api/sessions/rename`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 's1', title: 'New' }) });
    assert.equal(res.status, 200);
    assert.deepEqual(renamed, { id: 's1', title: 'New' });
  });
});

test('GET /api/config returns engine state; PUT /api/config toggles autoApprove', async () => {
  let auto = false;
  const engine = fakeEngine({ autoApprove: false });
  engine.setAutoApprove = (v: boolean) => { auto = v; };
  engine.getAutoApprove = () => auto;
  await withRoutes(t, engine, fakeStore(), {}, async (base) => {
    const cfg = await (await fetch(`${base}/api/config`)).json();
    assert.equal(cfg.autoApprove, false);
    const put = await fetch(`${base}/api/config`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ autoApprove: true }) });
    assert.equal(put.status, 200);
    const cfg2 = await (await fetch(`${base}/api/config`)).json();
    assert.equal(cfg2.autoApprove, true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test --experimental-transform-types tests/server/routes.test.ts`
Expected: `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement the route files**

`src/server/routes/chat.ts`:

```ts
import type { HttpServer } from '../http.ts';
import { HttpError } from '../http-error.ts';
import type { DaedalusEngine } from '../../core/engine.ts';
import type { WebSocketHub } from '../ws.ts';

/** POST /api/chat — 一次一轮 engine.run；事件经 ws 推给浏览器。运行中拒绝（409）。 */
export function registerChatRoutes(http: HttpServer, engine: DaedalusEngine, hub: WebSocketHub): void {
  http.post('/api/chat', async (_req, body) => {
    if (typeof body !== 'object' || body === null) throw new HttpError(400, 'missing body');
    const prompt = (body as { prompt?: unknown }).prompt;
    if (typeof prompt !== 'string' || !prompt.trim()) throw new HttpError(400, 'missing prompt');
    try {
      const result = await engine.run(prompt);
      return { status: 'ok', result };
    } catch (e) {
      const err = e as { message: string; status?: number };
      throw new HttpError(err.status ?? 500, err.message);
    }
  });
  // 引擎事件 → ws 广播（在 server.ts 装配 engine.subscribe 时接，chat 路由只管 run）
}
```

`src/server/routes/sessions.ts`:

```ts
import type { HttpServer } from '../http.ts';
import { HttpError } from '../http-error.ts';
import type { DaedalusEngine } from '../../core/engine.ts';
import type { SessionStore } from '../../core/session-store.ts';

export function registerSessionRoutes(http: HttpServer, engine: DaedalusEngine, store: SessionStore): void {
  http.get('/api/sessions', async () => ({ sessions: await store.list() }));

  http.post('/api/sessions', async (_req, body) => {
    const id = (body as { id?: unknown })?.id;
    if (id !== undefined && typeof id !== 'string') throw new HttpError(400, 'invalid id');
    if (typeof id === 'string') {
      const meta = await engine.resume(id);
      return { resumed: meta.id };
    }
    const cleared = engine.clearConversation();
    return { cleared };
  });

  http.put('/api/sessions/rename', async (_req, body) => {
    if (typeof body !== 'object' || body === null) throw new HttpError(400, 'missing body');
    const { id, title } = body as { id?: unknown; title?: unknown };
    if (typeof id !== 'string' || typeof title !== 'string') throw new HttpError(400, 'id and title required');
    await store.rename(id, title);
    return { ok: true };
  });

  http.post('/api/sessions/delete', async (_req, body) => {
    if (typeof body !== 'object' || body === null) throw new HttpError(400, 'missing body');
    const id = (body as { id?: unknown }).id;
    if (typeof id !== 'string') throw new HttpError(400, 'id required');
    await store.remove(id);
    return { ok: true };
  });
}
```

`src/server/routes/agents.ts`:

```ts
import type { HttpServer } from '../http.ts';
import { HttpError } from '../http-error.ts';
import type { DaedalusEngine } from '../../core/engine.ts';

export function registerAgentRoutes(http: HttpServer, engine: DaedalusEngine): void {
  http.get('/api/agents', async () => ({ agents: engine.listSubagents() }));

  http.get('/api/agents/messages', async (_req, _body, query) => {
    const name = query.get('name');
    if (!name) throw new HttpError(400, 'name required');
    return { messages: engine.getSubagentMessages(name) };
  });

  http.post('/api/agents/close', async (_req, body) => {
    if (typeof body !== 'object' || body === null) throw new HttpError(400, 'missing body');
    const name = (body as { name?: unknown }).name;
    if (typeof name !== 'string') throw new HttpError(400, 'name required');
    engine.closeSubagent(name);
    return { ok: true };
  });
}
```

`src/server/routes/config.ts`:

```ts
import type { HttpServer } from '../http.ts';
import { HttpError } from '../http-error.ts';
import type { DaedalusEngine } from '../../core/engine.ts';

export function registerConfigRoutes(http: HttpServer, engine: DaedalusEngine): void {
  http.get('/api/config', async () => ({
    model: engine.getModel() ?? null,
    autoApprove: engine.getAutoApprove(),
    planMode: engine.getPlanMode(),
  }));

  http.put('/api/config', async (_req, body) => {
    if (typeof body !== 'object' || body === null) throw new HttpError(400, 'missing body');
    const b = body as { model?: unknown; autoApprove?: unknown; planMode?: unknown };
    if (b.model !== undefined) {
      if (typeof b.model !== 'string') throw new HttpError(400, 'model must be string');
      engine.setModel(b.model);
    }
    if (b.autoApprove !== undefined) {
      if (typeof b.autoApprove !== 'boolean') throw new HttpError(400, 'autoApprove must be boolean');
      engine.setAutoApprove(b.autoApprove);
    }
    if (b.planMode !== undefined) {
      if (typeof b.planMode !== 'boolean') throw new HttpError(400, 'planMode must be boolean');
      engine.setPlanMode(b.planMode);
    }
    return { ok: true };
  });

  http.get('/api/state', async () => ({
    messages: engine.getSessionState().messages,
    subagents: engine.listSubagents(),
    config: {
      model: engine.getModel() ?? null,
      autoApprove: engine.getAutoApprove(),
      planMode: engine.getPlanMode(),
    },
  }));
}
```

`src/server/routes/index.ts`:

```ts
import type { HttpServer } from '../http.ts';
import type { DaedalusEngine } from '../../core/engine.ts';
import type { SessionStore } from '../../core/session-store.ts';
import type { WebSocketHub } from '../ws.ts';
import { registerChatRoutes } from './chat.ts';
import { registerSessionRoutes } from './sessions.ts';
import { registerAgentRoutes } from './agents.ts';
import { registerConfigRoutes } from './config.ts';

export interface RouteDeps {
  engine: DaedalusEngine;
  store: SessionStore;
  hub: WebSocketHub;
}

export function registerAll(http: HttpServer, deps: RouteDeps): void {
  registerChatRoutes(http, deps.engine, deps.hub);
  registerSessionRoutes(http, deps.engine, deps.store);
  registerAgentRoutes(http, deps.engine);
  registerConfigRoutes(http, deps.engine);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test --experimental-transform-types tests/server/routes.test.ts`
Expected: all pass.

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck`
Commit:

```bash
git add src/server/routes/ tests/server/routes.test.ts
git commit -m "feat(server): REST routes (chat/sessions/agents/config/state)"
```

---

### Task 7: Server assembly (`server.ts`) + `daedalus web` subcommand

**Files:**
- Create: `src/server/server.ts`
- Create: `src/server/static.ts`
- Modify: `src/cli/flags.ts` (add `--port`)
- Modify: `src/cli/main.ts` (dispatch `web` subcommand)
- Test: `tests/server/server.test.ts`

**Interfaces:**
- Consumes: `createAiClient` + config loading (`src/config/config.ts`), `DaedalusEngine`, `SessionStore`, `HttpServer`, `WebSocketHub`, `EventHub`, `WebPermissionManager`, `registerAll`, `staticDirFor`, `lanIPv4`.
- Produces:
  - `staticDirFor(moduleUrl: string): string` (copy anther) — `<dir of module>/../web`
  - `lanIPv4(): string | null` (copy anther)
  - `export async function main(argv: string[]): Promise<void>` — parses `--port` (default 3100, env `DAEDALUS_WEB_PORT`), assembles engine + ws + routes, subscribes `hub.broadcastEvent` to engine, installs `permission.ask` via `engine.setAskPermission`, prints URLs, handles SIGINT/SIGTERM → dispose.
  - Engine config: `loadConfig()` → provider/model/apiKey/baseURL; `createAiClient`; `cwd = process.cwd()`; `sessionStore = new SessionStore()`.

- [ ] **Step 1: Write the failing test** (`tests/server/server.test.ts`) — build the server against a stub config so no real API key is needed:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// server.ts main() reads config from env + config file; we drive it via a
// hand-assembled server instead (see server.ts exposing `buildServer`).

test('server assembly wires engine, ws, routes, permission (smoke)', async () => {
  // buildServer returns { http, engine, hub, close }; see Step 3.
  const { buildServer } = await import('../../src/server/server.ts');
  const store = new (await import('../../src/core/session-store.ts')).SessionStore(mkdtempSync(join(tmpdir(), 'dae-srv-')));
  const engineStub = {
    subscribe: () => () => {},
    setAskPermission: () => {},
    run: async (p: string) => `ok:${p}`,
    getSessionState: () => ({ messages: [], loadedSkills: [] }),
    listSessions: async () => [],
    listSubagents: () => [],
    getSubagentMessages: () => [],
    closeSubagent: () => {},
    resume: async () => ({ id: 'x', updatedAt: '', messageCount: 0 }),
    clearConversation: () => 0,
    getModel: () => null, setModel: () => {},
    getAutoApprove: () => false, setAutoApprove: () => {},
    getPlanMode: () => false, setPlanMode: () => {},
    usage: () => ({ inputTokens: 0, outputTokens: 0 }),
  };
  const srv = buildServer({ engine: engineStub as any, store, staticDir: process.cwd() });
  await srv.listen(0, '127.0.0.1');
  const { port } = srv.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${port}/api/config`);
  assert.equal(res.status, 200);
  await srv.close();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --experimental-transform-types tests/server/server.test.ts`
Expected: `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement `src/server/static.ts`**

```ts
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** 静态目录解析：源码（src/server/static.ts）→ <root>/web；产物（dist/server/static.js）→ <root>/dist/web。 */
export function staticDirFor(moduleUrl: string): string {
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), '../web');
}

/** 第一个非回环 IPv4；取不到返回 null（启动日志专用，绝不能带崩进程）。 */
export function lanIPv4(): string | null {
  let interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  try {
    interfaces = os.networkInterfaces();
  } catch {
    return null;
  }
  for (const infos of Object.values(interfaces)) {
    if (!infos) continue;
    for (const info of infos) {
      if (info.family === 'IPv4' && !info.internal) return info.address;
    }
  }
  return null;
}
```

- [ ] **Step 4: Implement `src/server/server.ts`**

```ts
import { HttpServer } from './http.ts';
import { EventHub } from './event-hub.ts';
import { WebSocketHub } from './ws.ts';
import { WebPermissionManager } from './permission.ts';
import { registerAll } from './routes/index.ts';
import { staticDirFor, lanIPv4 } from './static.ts';
import type { DaedalusEngine } from '../core/engine.ts';
import type { SessionStore } from '../core/session-store.ts';

export interface ServerDeps {
  engine: DaedalusEngine;
  store: SessionStore;
  staticDir?: string;
}

/** 装配 engine + ws + 路由；返回可 listen/close 的服务（测试友好）。 */
export function buildServer(deps: ServerDeps): {
  http: HttpServer;
  engine: DaedalusEngine;
  hub: WebSocketHub;
  permission: WebPermissionManager;
  listen(port: number, host: string): Promise<void>;
  address(): ReturnType<HttpServer['address']>;
  close(): Promise<void>;
} {
  const http = new HttpServer({ staticDir: deps.staticDir ?? staticDirFor(import.meta.url) });
  const hub = new EventHub();
  const permission = new WebPermissionManager(deps.engine);
  const wsHub = new WebSocketHub({ engine: deps.engine, hub, permission });
  wsHub.attach(http);
  registerAll(http, { engine: deps.engine, store: deps.store, hub: wsHub });

  // 引擎事件 → ws 广播；引擎权限 → web 审批。
  deps.engine.subscribe((ev) => wsHub.broadcastEvent(ev));
  deps.engine.setAskPermission(permission.ask);
  permission.setBroadcast((msg) => wsHub.broadcast(msg));

  return {
    http,
    engine: deps.engine,
    hub: wsHub,
    permission,
    listen: (port, host) => http.listen(port, host),
    address: () => http.address(),
    close: () => http.close(),
  };
}

export async function main(argv: string[]): Promise<void> {
  let port = Number(process.env.DAEDALUS_WEB_PORT ?? 3100);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') {
      const raw = argv[++i];
      if (!raw || !/^\d+$/.test(raw)) throw new Error('invalid --port');
      port = Number(raw);
    }
  }
  // 复用 CLI 的 config 装配：provider/model/apiKey/baseURL → client
  const { loadConfig } = await import('../config/config.ts');
  const { createAiClient } = await import('../ai/index.ts');
  const base = loadConfig();
  const client = createAiClient({
    provider: base.provider as 'openai' | 'anthropic',
    apiKey: base.apiKey,
    baseURL: base.baseURL,
    model: base.model,
  });
  const { DaedalusEngine } = await import('../core/engine.ts');
  const { SessionStore } = await import('../core/session-store.ts');
  const store = new SessionStore();
  const engine = new DaedalusEngine({
    client,
    cwd: process.cwd(),
    sessionStore: store,
    model: base.model,
    thinking: base.thinking,
    thinkingBudgetTokens: base.thinkingBudgetTokens,
    ...(base.hooks ? { hooks: base.hooks } : {}),
  });
  const srv = buildServer({ engine, store });

  const shutdown = async () => {
    srv.http.close();
    await engine.dispose();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());

  await srv.listen(port, '0.0.0.0');
  console.log(`daedalus web started: http://localhost:${port}`);
  const lan = lanIPv4();
  if (lan) console.log(`LAN access: http://${lan}:${port}`);
  console.log(`Sessions: ${store.dir}`);
}

// 直接运行时（node src/server/server.ts / dist/server/server.js）启动；被 import（测试）时不执行。
// 复制 anther cli.ts 的守卫。
import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
  });
}
```

- [ ] **Step 5: Modify `src/cli/flags.ts`** — add `--port`:

```ts
else if (a === '--port') flags.port = argv[++i];
```

- [ ] **Step 6: Modify `src/cli/main.ts`** — dispatch `web` subcommand right after the help/version blocks (BEFORE `missingProvider`/config loading), so it never needs an API key prompt:

```ts
// at top, after existing imports:
import { main as webMain } from '../server/server.ts';

// after the version block, before `let base: DaedalusConfig`:
const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'web') {
  try {
    await webMain(rest);
  } catch (e) {
    console.error((e as Error).message ?? e);
    process.exit(1);
  }
  process.exit(0);
}
```

(Note: `parseFlags` is still called earlier for help/version; `web` bypasses the config/setup wizard entirely. Existing TUI/REPL/`-p` behavior untouched — `daedalus` with no subcommand still runs the interactive path.)

- [ ] **Step 7: Run the test + typecheck**

Run: `node --test --experimental-transform-types tests/server/server.test.ts` and `npm run typecheck`
Expected: pass + clean.

- [ ] **Step 8: Commit**

```bash
git add src/server/server.ts src/server/static.ts src/cli/flags.ts src/cli/main.ts tests/server/server.test.ts
git commit -m "feat(cli): daedalus web — server assembly, static dir, port 3100"
```

---

### Task 8: Frontend data layer — state-model, ws client, api

**Files:**
- Create: `web/src/types.ts`
- Create: `web/src/state-model.ts`
- Create: `web/src/ws.ts`
- Create: `web/src/api.ts`
- Create: `web/src/stores.ts`
- Test: `web/src/state-model.test.ts`, `web/src/ws.test.ts`, `web/src/api.test.ts`

**Interfaces:**
- Consumes: `CoreEvent` shape (from `src/core/events.ts`), `SnapshotPayload` shape.
- Produces:
  - `types.ts`: `EventEnvelope = { type: 'event'; ev: CoreEvent } | { type: 'snapshot'; ... } | { type: 'permission'; id; action; target } | { type: 'permission_cancel'; id }`
  - `state-model.ts`: PURE types + reducer —
    - `export interface ToolCard { id: string; name: string; status: 'running' | 'done' | 'error'; inputPreview: string; content: string; diff?: string }`
    - `export interface AgentView { name: string; task: string; status: 'running' | 'done' | 'error'; messages: unknown[] }`
    - `export interface UiState { messages: unknown[]; subagents: AgentView[]; running: boolean; log: CoreEvent[]; pendingPermission: { id; action; target } | null; autoApprove: boolean }`
    - `export function initialUiState(): UiState`
    - `export function applyEnvelope(state: UiState, env: EventEnvelope): UiState` (pure, immutable-ish; returns a new state)
    - `export function mergeSnapshot(state: UiState, snap: SnapshotPayload): UiState`
  - `ws.ts`: `export function connectWs(opts: { url: string; onEnvelope: (e: EventEnvelope) => void; onStatus: (s: 'connecting' | 'open' | 'closed') => void }): () => void` (returns close; auto-reconnects with backoff)
  - `api.ts`: `export async function chat(prompt): Promise<{status:'ok';result:string}|{status:'error';error:string}>`; `export async function listSessions(): Promise<SessionMeta[]>`; `export async function renameSession(id,title)`; `export async function deleteSession(id)`; `export async function getConfig(): Promise<Config>`; `export async function putConfig(patch): Promise<void>`

**TDD order:** write state-model tests first (pure), then ws + api.

- [ ] **Step 1: Write the failing state-model tests** (`web/src/state-model.test.ts`):

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialUiState, applyEnvelope, mergeSnapshot } from './state-model.ts';
import type { EventEnvelope, SnapshotPayload } from './types.ts';
import type { CoreEvent } from '../../src/core/events.ts';

test('initial state is empty and idle', () => {
  const s = initialUiState();
  assert.deepEqual(s.subagents, []);
  assert.equal(s.running, false);
  assert.equal(s.pendingPermission, null);
});

test('text_delta streams accumulate into the last message', () => {
  let s = initialUiState();
  s = applyEnvelope(s, ev('text_delta', { text: 'Hel' }));
  s = applyEnvelope(s, ev('text_delta', { text: 'lo' }));
  assert.equal(s.log.length, 2);
  assert.equal(s.running, true);
});

test('tool_call_start creates a running card; tool_result marks done', () => {
  let s = initialUiState();
  s = applyEnvelope(s, ev('tool_call_start', { id: 't1', name: 'bash' }));
  assert.equal(s.log[0].type, 'tool_call_start');
  s = applyEnvelope(s, ev('tool_result', { id: 't1', name: 'bash', input: {}, content: 'out' }));
  assert.equal(s.running, false); // done would follow in real flow; tool_result alone doesn't end
});

test('done clears the in-flight log and stops running', () => {
  let s = initialUiState();
  s = applyEnvelope(s, ev('text_delta', { text: 'x' }));
  s = applyEnvelope(s, ev('done', { message: { role: 'assistant', content: [] } }));
  assert.equal(s.running, false);
  assert.deepEqual(s.log, []);
});

test('delegate_start adds a subagent to the list', () => {
  let s = initialUiState();
  s = applyEnvelope(s, ev('delegate_start', { agent: 'researcher', task: 'find' }));
  assert.equal(s.subagents.length, 1);
  assert.equal(s.subagents[0].name, 'researcher');
  assert.equal(s.subagents[0].status, 'running');
});

test('mergeSnapshot replaces log+messages+subagents and sets running', () => {
  let s = initialUiState();
  s = mergeSnapshot(s, {
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    subagents: [{ name: 'a', task: 't', status: 'done', messageCount: 0, loadedSkills: [] }],
    running: true,
    log: [],
    pendingPermission: null,
  });
  assert.equal(s.messages.length, 1);
  assert.equal(s.running, true);
  assert.equal(s.subagents[0].status, 'done');
});

function ev(type: CoreEvent['type'], extra: Record<string, unknown>): EventEnvelope {
  return { type: 'event', ev: { type, ...extra } as unknown as CoreEvent };
}
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test --experimental-transform-types web/src/state-model.test.ts`
Expected: `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement `web/src/types.ts`**

```ts
import type { CoreEvent } from '../../src/core/events.ts';

export type EventEnvelope =
  | { type: 'event'; ev: CoreEvent }
  | ({ type: 'snapshot' } & SnapshotPayload)
  | { type: 'permission'; id: string; action: string; target: string }
  | { type: 'permission_cancel'; id: string };

export type ChatResult = { status: 'ok'; result: string } | { status: 'error'; error: string };

export interface SnapshotPayload {
  messages: unknown[];
  subagents: Array<{ name: string; task: string; status: string; messageCount: number; loadedSkills: string[] }>;
  running: boolean;
  log: CoreEvent[];
  pendingPermission: { id: string; action: string; target: string } | null;
}
```

- [ ] **Step 4: Implement `web/src/state-model.ts`**

```ts
import type { CoreEvent } from '../../src/core/events.ts';
import type { EventEnvelope } from './types.ts';

export interface SubagentInfo {
  name: string;
  task: string;
  status: 'running' | 'done' | 'error' | 'queued';
  messageCount: number;
  loadedSkills: string[];
  /** 该 agent 的实时 CoreEvent 累积（detail 页 live 渲染用；snapshot 重置）。 */
  events: CoreEvent[];
}

export interface UiState {
  messages: unknown[];
  subagents: SubagentInfo[];
  running: boolean;
  log: CoreEvent[];
  pendingPermission: { id: string; action: string; target: string } | null;
  autoApprove: boolean;
}

const TERMINALS: ReadonlySet<CoreEvent['type']> = new Set(['done', 'error']);

export function initialUiState(): UiState {
  return { messages: [], subagents: [], running: false, log: [], pendingPermission: null, autoApprove: false };
}

export function applyEnvelope(state: UiState, env: EventEnvelope): UiState {
  if (env.type === 'snapshot') return mergeSnapshot(state, env);
  if (env.type === 'permission') return { ...state, pendingPermission: { id: env.id, action: env.action, target: env.target } };
  if (env.type === 'permission_cancel') return { ...state, pendingPermission: null };
  const ev = env.ev;
  if (ev.agent === undefined) {
    // main-session events: accumulate into the in-flight log
    const log = TERMINALS.has(ev.type) ? [] : [...state.log, ev];
    return { ...state, log, running: log.length > 0 };
  }
  // subagent events: update the subagent entry + accumulate its live events
  const idx = state.subagents.findIndex((a) => a.name === ev.agent);
  if (idx < 0 && ev.type !== 'delegate_start') return state;
  let subagents: SubagentInfo[];
  if (idx < 0) {
    subagents = [...state.subagents, { name: ev.agent!, task: (ev as { task?: string }).task ?? '', status: 'running', messageCount: 0, loadedSkills: [], events: [ev] }];
  } else {
    subagents = state.subagents.map((a) => {
      if (a.name !== ev.agent) return a;
      const events = [...a.events, ev];
      switch (ev.type) {
        case 'delegate_start': return { ...a, task: (ev as { task?: string }).task ?? a.task, status: 'running', events };
        case 'done': return { ...a, status: 'done', events };
        case 'error': return { ...a, status: 'error', events };
        default: return { ...a, events };
      }
    });
  }
  return { ...state, subagents };
}

export function mergeSnapshot(state: UiState, snap: SnapshotPayload): UiState {
  return {
    ...state,
    messages: snap.messages,
    subagents: snap.subagents.map((a) => ({
      name: a.name, task: a.task,
      status: (a.status === 'done' || a.status === 'error' ? a.status : 'running') as SubagentInfo['status'],
      messageCount: a.messageCount, loadedSkills: a.loadedSkills,
      events: [],
    })),
    running: snap.running,
    log: [...snap.log],
    pendingPermission: snap.pendingPermission,
  };
}
```

- [ ] **Step 5: Run state-model tests**

Run: `node --test --experimental-transform-types web/src/state-model.test.ts`
Expected: pass.

- [ ] **Step 6: Write ws-client + api tests** (`web/src/ws.test.ts`, `web/src/api.test.ts`):

```ts
// ws.test.ts — pure message parsing helper (no real sockets in tests):
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMessage } from './ws.ts';

test('parseMessage decodes envelopes and ignores junk', () => {
  assert.equal(parseMessage('{"type":"event","ev":{"type":"text_delta","text":"x"}}').ev.text, 'x');
  assert.equal(parseMessage('not json'), null);
});
```

```ts
// api.test.ts — fetch is stubbed via globalThis.fetch:
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chat } from './api.ts';

test('chat returns ok on 200', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ status: 'ok', result: 'r' }), { status: 200, headers: { 'Content-Type': 'application/json' } }) as any;
  const res = await chat('hi');
  assert.deepEqual(res, { status: 'ok', result: 'r' });
});
```

- [ ] **Step 7: Implement `web/src/ws.ts`**

```ts
import type { EventEnvelope } from './types.ts';

export type WsStatus = 'connecting' | 'open' | 'closed';

/** 当前活动连接的发送函数；未连接时发送被忽略（权限卡点击安全兜底）。 */
let activeSend: ((raw: string) => void) | null = null;

export function sendWsMessage(msg: unknown): void {
  if (activeSend) activeSend(JSON.stringify(msg));
}

/** 从任意收到的字符串解码事件信封；非法输入返回 null（测试用纯函数）。 */
export function parseMessage(raw: string): EventEnvelope | null {
  try {
    const obj = JSON.parse(raw) as unknown;
    if (obj && typeof obj === 'object' && 'type' in (obj as object)) return obj as EventEnvelope;
  } catch { /* ignore */ }
  return null;
}

/** 连接 ws（自动重连：指数退避 1s→2s→4s→…，上限 10s）。返回关闭函数。 */
export function connectWs(opts: {
  url: string;
  onEnvelope: (e: EventEnvelope) => void;
  onStatus: (s: WsStatus) => void;
}): () => void {
  let closed = false;
  let ws: WebSocket | null = null;
  let backoff = 1000;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const open = () => {
    if (closed) return;
    opts.onStatus('connecting');
    ws = new WebSocket(opts.url);
    ws.onopen = () => { backoff = 1000; activeSend = (raw) => ws?.send(raw); opts.onStatus('open'); };
    ws.onmessage = (m) => {
      const env = parseMessage(String(m.data));
      if (env) opts.onEnvelope(env);
    };
    ws.onclose = () => {
      if (activeSend && ws) { /* send owned by this socket */ }
      activeSend = null;
      opts.onStatus('closed');
      if (!closed) {
        timer = setTimeout(open, backoff);
        backoff = Math.min(backoff * 2, 10_000);
      }
    };
    ws.onerror = () => ws?.close();
  };
  open();

  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    ws?.close();
  };
}
```

- [ ] **Step 8: Implement `web/src/api.ts`**

```ts
import type { ChatResult } from './types.ts';

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

export async function chat(prompt: string): Promise<ChatResult> {
  try {
    const r = await request<{ status: 'ok'; result: string }>('POST', '/api/chat', { prompt });
    return { status: 'ok', result: r.result };
  } catch (e) {
    return { status: 'error', error: (e as Error).message };
  }
}

export async function listSessions(): Promise<Array<{ id: string; title: string; updatedAt: string; messageCount: number }>> {
  const r = await request<{ sessions: Array<{ id: string; title: string; updatedAt: string; messageCount: number }> }>('GET', '/api/sessions');
  return r.sessions;
}
export async function renameSession(id: string, title: string): Promise<void> {
  await request('PUT', '/api/sessions/rename', { id, title });
}
export async function deleteSession(id: string): Promise<void> {
  await request('POST', '/api/sessions/delete', { id });
}
export async function getConfig(): Promise<{ model: string | null; autoApprove: boolean; planMode: boolean }> {
  return request('GET', '/api/config');
}
export async function putConfig(patch: { autoApprove?: boolean; planMode?: boolean; model?: string }): Promise<void> {
  await request('PUT', '/api/config', patch);
}
```

- [ ] **Step 9: Implement `web/src/stores.ts`** (solid signals wrapping the reducer)

```ts
import { createSignal } from 'solid-js';
import { initialUiState, applyEnvelope, mergeSnapshot, type UiState } from './state-model.ts';
import type { SnapshotPayload } from './types.ts';
import type { EventEnvelope } from './types.ts';

export const [state, setState] = createSignal<UiState>(initialUiState());

/** ws 事件进 store：纯归并后写信号。 */
export function handleEnvelope(env: EventEnvelope): void {
  if (env.type === 'snapshot') {
    setState((s) => mergeSnapshot(s, env));
    return;
  }
  setState((s) => applyEnvelope(s, env));
}
```

- [ ] **Step 10: Run all web tests + typecheck**

Run: `node --test --experimental-transform-types web/src/*.test.ts` and `npm run typecheck`
Expected: pass + clean (web tsconfig excludes `*.test.ts`).

- [ ] **Step 11: Commit**

```bash
git add web/src/types.ts web/src/state-model.ts web/src/ws.ts web/src/api.ts web/src/stores.ts web/src/state-model.test.ts web/src/ws.test.ts web/src/api.test.ts
git commit -m "feat(web): pure state-model reducer + ws client + api wrapper"
```

---

### Task 9: Main chat view components

**Files:**
- Create: `web/src/components/chat/message.tsx`
- Create: `web/src/components/chat/stream.tsx`
- Create: `web/src/components/chat/thinking.tsx`
- Create: `web/src/components/chat/tool-card.tsx`
- Create: `web/src/components/chat/delegate-row.tsx`
- Create: `web/src/components/chat/event-line.tsx`
- Create: `web/src/components/chat/permission-card.tsx`
- Create: `web/src/components/chat/input.tsx`
- Create: `web/src/components/common/badge.tsx`
- Modify: `web/src/App.tsx` (main chat screen)

**Interfaces:**
- Consumes: `state` signal from `stores.ts`, `chat()` + `putConfig()` from `api.ts`, `CoreEvent` shapes.
- Produces: `MainChat` component rendering the three-zone layout + input; each sub-component is pure-ish (props from `state`).

This task is UI-only; no new test files (rendering is untested per spec; logic lives in state-model). **Manual smoke step** at the end.

- [ ] **Step 1: Create `web/src/components/common/badge.tsx`**

```tsx
export function Badge(props: { status: 'running' | 'done' | 'error' | 'queued' }) {
  const sym = { running: '●', done: '✓', error: '✗', queued: '◇' }[props.status];
  const cls = `badge badge-${props.status}`;
  return <span class={cls} title={props.status}>{sym} {props.status}</span>;
}
```

- [ ] **Step 2: Create `web/src/components/chat/message.tsx`** (user + assistant bubble; assistant renders text blocks via `stream.tsx`, tool_calls via `tool-card.tsx`, thinking via `thinking.tsx`)

```tsx
import { For, Show } from 'solid-js';
import { ToolCard } from './tool-card.tsx';
import { Thinking } from './thinking.tsx';
import { StreamText } from './stream.tsx';

export function MessageBubble(props: { message: any }) {
  const m = () => props.message;
  return (
    <div class={`msg msg-${m().role}`}>
      {m().role === 'user' ? (
        <div class="msg-text">{m().content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')}</div>
      ) : (
        <For each={m().content}>
          {(c: any) => (
            <>
              {c.type === 'text' && <StreamText text={c.text} />}
              {c.type === 'thinking' && <Thinking text={c.thinking} />}
              {c.type === 'tool_call' && <ToolCard tool={c} status="done" />}
            </>
          )}
        </For>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Create `web/src/components/chat/stream.tsx`**

```tsx
export function StreamText(props: { text: string }) {
  return <div class="msg-text" innerHTML={escapeHtml(props.text).replace(/\n/g, '<br>')} />;
}
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}
```

- [ ] **Step 4: Create `web/src/components/chat/thinking.tsx`** (collapsible)

```tsx
import { createSignal } from 'solid-js';
export function Thinking(props: { text: string }) {
  const [open, setOpen] = createSignal(false);
  return (
    <div class="thinking" onClick={() => setOpen(!open())}>
      <span class="thinking-toggle">{open() ? '▼' : '▶'} thinking</span>
      {open() && <div class="thinking-body">{props.text}</div>}
    </div>
  );
}
```

- [ ] **Step 5: Create `web/src/components/chat/tool-card.tsx`** (title + status + expandable input/content/diff; red border on error; diff line coloring)

```tsx
import { createSignal, Show } from 'solid-js';

export function DiffBlock(props: { diff: string }) {
  return (
    <pre class="diff">
      {props.diff.split('\n').map((line) => (
        <div class={line.startsWith('+') && !line.startsWith('+++') ? 'diff-add' : line.startsWith('-') && !line.startsWith('---') ? 'diff-del' : ''}>{line || ' '}</div>
      ))}
    </pre>
  );
}

export function ToolCard(props: { tool: any; status: 'running' | 'done' | 'error' }) {
  const [open, setOpen] = createSignal(false);
  const inputPreview = () => {
    try { return JSON.stringify(props.tool.input).slice(0, 120); } catch { return String(props.tool.input); }
  };
  return (
    <div class={`tool-card ${props.status}`} onClick={() => setOpen(!open())}>
      <span class="tool-title">{props.status === 'running' ? '⏳' : props.status === 'error' ? '✗' : '✓'} {props.tool.name}</span>
      <span class="tool-input-preview">{inputPreview()}</span>
      {open() && (
        <div class="tool-body">
          {props.tool.resultContent && <pre class="tool-content">{props.tool.resultContent}</pre>}
          {props.tool.diff && <DiffBlock diff={props.tool.diff} />}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Create `web/src/components/chat/delegate-row.tsx`**

```tsx
import { Badge } from '../common/badge.tsx';
export function DelegateRow(props: { name: string; task: string; status: 'running' | 'done' | 'error' | 'queued' }) {
  return (
    <a class="delegate-row" href={`#/agent/${encodeURIComponent(props.name)}`}>
      <Badge status={props.status} />
      <span class="delegate-name">subagent [{props.name}]</span>
      {props.task && <span class="delegate-task">{props.task}</span>}
    </a>
  );
}
```

- [ ] **Step 7: Create `web/src/components/chat/event-line.tsx`** (compact/trim/skill notices)

```tsx
export function EventLine(props: { text: string }) {
  return <div class="event-line">{props.text}</div>;
}
```

- [ ] **Step 8: Create `web/src/components/chat/permission-card.tsx`**

```tsx
import { Show } from 'solid-js';
export function PermissionCard(props: { pending: { id: string; action: string; target: string } | null; send: (m: { type: 'permission'; id: string; allow: boolean; always?: boolean }) => void }) {
  const p = () => props.pending;
  return (
    <Show when={p()}>
      <div class="permission-card">
        <div class="permission-title">允许 {p()!.action}?</div>
        <pre class="permission-target">{p()!.target}</pre>
        <div class="permission-btns">
          <button onClick={() => props.send({ type: 'permission', id: p()!.id, allow: true })}>允许</button>
          <button onClick={() => props.send({ type: 'permission', id: p()!.id, allow: true, always: true })}>本轮始终允许</button>
          <button onClick={() => props.send({ type: 'permission', id: p()!.id, allow: false })}>拒绝</button>
        </div>
      </div>
    </Show>
  );
}
```

- [ ] **Step 9: Create `web/src/components/chat/input.tsx`**

```tsx
import { createSignal, Show } from 'solid-js';
export function ChatInput(props: { disabled: boolean; autoApprove: boolean; onSend: (prompt: string) => void; onToggleAuto: () => void }) {
  const [text, setText] = createSignal('');
  const submit = () => {
    const t = text().trim();
    if (!t || props.disabled) return;
    props.onSend(t);
    setText('');
  };
  return (
    <div class="chat-input">
      <textarea
        rows={1}
        value={text()}
        placeholder={props.disabled ? '运行中…' : '输入消息'}
        onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
        }}
      />
      <button class="send-btn" onClick={submit} disabled={props.disabled}>⏎</button>
      <button class="auto-toggle" classList={{ 'auto-on': props.autoApprove }} onClick={props.onToggleAuto} title="权限模式切换">
        {props.autoApprove ? 'auto' : 'ask'}
      </button>
    </div>
  );
}
```

- [ ] **Step 10: Wire the main screen into `web/src/App.tsx`**

```tsx
import { createSignal, For, Show } from 'solid-js';
import { state } from './stores.ts';
import { chat, putConfig, getConfig } from './api.ts';
import { connectWs, sendWsMessage, type WsStatus } from './ws.ts';
import { handleEnvelope } from './stores.ts';
import { ChatInput } from './components/chat/input.tsx';
import { MessageBubble } from './components/chat/message.tsx';
import { DelegateRow } from './components/chat/delegate-row.tsx';
import { EventLine } from './components/chat/event-line.tsx';
import { PermissionCard } from './components/chat/permission-card.tsx';
import { Badge } from './components/common/badge.tsx';

export function App() {
  const [wsStatus, setWsStatus] = createSignal<WsStatus>('connecting');

  // ws 连接一次（应用生命周期）：事件 → store
  connectWs({
    url: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws`,
    onEnvelope: handleEnvelope,
    onStatus: setWsStatus,
  });
  void getConfig().then((c) => { /* config 信号挂到 store —— Task 10 细化 */ });

  const onSend = async (prompt: string) => {
    await chat(prompt); // 结果通过 ws 事件回流
  };
  const onToggleAuto = async () => {
    const next = !state().autoApprove;
    await putConfig({ autoApprove: next });
    // config 状态经 ws 不回传，简单起见本地更新（Task 10 用 snapshot/config 统一）
  };

  return (
    <div class="app">
      <header class="topbar">
        <span class="topbar-title">daedalus</span>
        <Badge status={state().running ? 'running' : 'done'} />
        <span class={`ws-dot ${wsStatus()}`} />
      </header>
      <div class="main">
        <div class="chat-stream">
          <For each={state().messages}>
            {(m) => <MessageBubble message={m} />}
          </For>
          <Show when={state().pendingPermission}>
            <PermissionCard pending={state().pendingPermission} send={(m) => sendWsMessage(m)} />
          </Show>
        </div>
        <aside class="subagents-panel">
          <h3>subagents</h3>
          <For each={state().subagents}>
            {(a) => <DelegateRow name={a.name} task={a.task} status={a.status} />}
          </For>
        </aside>
      </div>
      <ChatInput disabled={state().running} autoApprove={state().autoApprove} onSend={onSend} onToggleAuto={onToggleAuto} />
    </div>
  );
}
```

(Permission responses flow through `sendWsMessage` from `ws.ts` — no stub needed.)

- [ ] **Step 11: Manual smoke**

Run: `npm run dev`, open http://localhost:5173 (desktop) and the LAN URL on a phone.
Expected: chat view renders, ws dot turns green, typing + sending shows the prompt in the stream (engine events flow over ws).

- [ ] **Step 12: Commit**

```bash
git add web/src/components/ web/src/App.tsx
git commit -m "feat(web): main chat view (bubbles, thinking, tool cards, delegate rows, permission, input)"
```

---

### Task 10: Subagents panel + detail view + drawer + router

**Files:**
- Create: `web/src/routes.ts`
- Create: `web/src/components/agents/panel.tsx`
- Create: `web/src/components/agents/detail.tsx`
- Create: `web/src/components/common/drawer.tsx`
- Modify: `web/src/App.tsx` (router: main / #/agent/<name> / #/sessions; narrow drawer)

**Interfaces:**
- Consumes: `state`, `api.getSubagentMessages` (add to `api.ts`), `ApiError`.
- Produces:
  - `routes.ts`: `parseHash(): { route: 'main' } | { route: 'agent'; name: string } | { route: 'sessions' }`; `onHashChange(cb): () => void`
  - `App.tsx`: renders `MainChat` / `AgentDetail` / `SessionList` based on hash; narrow screens render the subagents panel inside a `Drawer` (top-left button opens).

- [ ] **Step 1: Add `getSubagentMessages` + `closeSubagent` to `web/src/api.ts`**

```ts
export async function getSubagentMessages(name: string): Promise<unknown[]> {
  const r = await request<{ messages: unknown[] }>('GET', `/api/agents/messages?name=${encodeURIComponent(name)}`);
  return r.messages;
}
export async function closeSubagent(name: string): Promise<void> {
  await request('POST', '/api/agents/close', { name });
}
```

- [ ] **Step 2: Write the failing router test** (`web/src/routes.test.ts`):

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHash } from './routes.ts';

test('parseHash routes main / agent / sessions', () => {
  assert.deepEqual(parseHash(''), { route: 'main' });
  assert.deepEqual(parseHash('#/'), { route: 'main' });
  assert.deepEqual(parseHash('#/sessions'), { route: 'sessions' });
  assert.deepEqual(parseHash('#/agent/researcher'), { route: 'agent', name: 'researcher' });
  assert.deepEqual(parseHash('#/agent/a%20b'), { route: 'agent', name: 'a b' });
  assert.deepEqual(parseHash('#/unknown'), { route: 'main' });
});
```

- [ ] **Step 3: Run to verify failure + implement `web/src/routes.ts`**

```ts
export type Route = { route: 'main' } | { route: 'agent'; name: string } | { route: 'sessions' };

export function parseHash(hash: string): Route {
  const h = hash.replace(/^#\/?/, '').replace(/\/$/, '');
  if (h === '') return { route: 'main' };
  if (h === 'sessions') return { route: 'sessions' };
  const m = /^agent\/(.+)$/.exec(h);
  if (m) return { route: 'agent', name: decodeURIComponent(m[1]) };
  return { route: 'main' };
}

export function onHashChange(cb: () => void): () => void {
  window.addEventListener('hashchange', cb);
  return () => window.removeEventListener('hashchange', cb);
}
```

- [ ] **Step 4: Run router test** — expected pass.

- [ ] **Step 5: Create `web/src/components/agents/panel.tsx`** (the list; used inline on wide, inside Drawer on narrow)

```tsx
import { For } from 'solid-js';
import { DelegateRow } from '../chat/delegate-row.tsx';
import type { SubagentInfo } from '../../state-model.ts';

export function SubagentPanel(props: { subagents: SubagentInfo[] }) {
  return (
    <div class="subagents-panel">
      <h3>subagents</h3>
      <For each={props.subagents}>
        {(a) => <DelegateRow name={a.name} task={a.task} status={a.status} />}
      </For>
    </div>
  );
}
```

- [ ] **Step 6: Create `web/src/components/common/drawer.tsx`**

```tsx
import { Show } from 'solid-js';
export function Drawer(props: { open: boolean; onClose: () => void; children: any }) {
  return (
    <Show when={props.open}>
      <div class="drawer-backdrop" onClick={props.onClose} />
      <div class="drawer">{props.children}</div>
    </Show>
  );
}
```

- [ ] **Step 7: Create `web/src/components/agents/detail.tsx`** (#/agent/<name> — internal event stream + history + status + reserved inter-agent area)

```tsx
import { createEffect, createSignal, For, Show } from 'solid-js';
import { state } from '../../stores.ts';
import { getSubagentMessages } from '../../api.ts';
import { Badge } from '../common/badge.tsx';
import { ToolCard } from '../chat/tool-card.tsx';
import { Thinking } from '../chat/thinking.tsx';

export function AgentDetail(props: { name: string }) {
  const agent = () => state().subagents.find((a) => a.name === props.name);
  const [history, setHistory] = createSignal<any[]>([]);
  createEffect(() => {
    const name = props.name;
    void getSubagentMessages(name).then((ms) => setHistory(ms)).catch(() => {});
  });
  return (
    <div class="agent-detail">
      <a class="back" href="#/">← 返回</a>
      <h2>subagent: {props.name}</h2>
      <Show when={agent()}>
        {(a) => (
          <>
            <div class="agent-meta">
              <Badge status={a().status} />
              <span class="agent-task">{a().task}</span>
            </div>
            <div class="agent-events">
              <For each={history()}>
                {(m: any) => (
                  <For each={m.content}>
                    {(c: any) => (
                      <>
                        {c.type === 'text' && <div class="msg-text">{c.text}</div>}
                        {c.type === 'thinking' && <Thinking text={c.thinking} />}
                        {c.type === 'tool_call' && <ToolCard tool={c} status="done" />}
                      </>
                    )}
                  </For>
                )}
              </For>
              {/* 实时 tagged 事件：state-model 已按 agent 累积到 a().events */}
              <For each={a().events}>
                {(e: any) => (
                  <>
                    {e.type === 'text_delta' && <div class="msg-text">{e.text}</div>}
                    {e.type === 'thinking_delta' && <div class="thinking-body">{e.thinking}</div>}
                    {e.type === 'tool_call_start' && <ToolCard tool={{ name: e.name, input: {} }} status="running" />}
                    {e.type === 'tool_result' && <div class="tool-content">{e.content}</div>}
                    {e.type === 'delegate_start' && <div class="event-line">→ subagent [{e.agent}] {e.task}</div>}
                  </>
                )}
              </For>
            </div>
          </>
        )}
      </Show>
      <div class="agent-interaction reserved">
        <span>agent 间交流：待开放</span>
      </div>
    </div>
  );
}
```

- [ ] **Step 8: Wire the router into `web/src/App.tsx`**

```tsx
import { createSignal, Show } from 'solid-js';
import { parseHash, onHashChange, type Route } from './routes.ts';
import { SubagentPanel } from './components/agents/panel.tsx';
import { AgentDetail } from './components/agents/detail.tsx';
import { SessionList } from './components/sessions/list.tsx';   // created in Task 11
import { Drawer } from './components/common/drawer.tsx';
import { useIsNarrow } from './App.tsx'; // hoisted to its own module in Step 9

export function App() {
  const isNarrow = useIsNarrow();
  const [route, setRoute] = createSignal<Route>(parseHash(location.hash));
  const [drawerOpen, setDrawerOpen] = createSignal(false);
  onHashChange(() => { setRoute(parseHash(location.hash)); setDrawerOpen(false); });

  return (
    <Show when={route().route === 'main'} fallback={
      route().route === 'agent' ? <AgentDetail name={route().name} /> : <SessionList />
    }>
      <div class="app">
        <header class="topbar">
          {isNarrow() && <button class="drawer-btn" onClick={() => setDrawerOpen(true)}>☰</button>}
          <span class="topbar-title">daedalus</span>
        </header>
        <div class="main">
          <div class="chat-stream">{/* Task 9 content moves here */}</div>
          {!isNarrow() && <SubagentPanel subagents={state().subagents} />}
        </div>
        {isNarrow() && (
          <Drawer open={drawerOpen()} onClose={() => setDrawerOpen(false)}>
            <SubagentPanel subagents={state().subagents} />
          </Drawer>
        )}
        {/* input + permission card */}
      </div>
    </Show>
  );
}
```

- [ ] **Step 9: Move `useIsNarrow` into its own module** (`web/src/use-is-narrow.ts`) so both App entry and the drawer use it; import from there.

- [ ] **Step 10: Manual smoke**

Run: `npm run dev` → run a `delegateMany`-style prompt; subagents appear in the panel (drawer on phone); click one → detail page shows its messages; back works.

- [ ] **Step 11: Commit**

```bash
git add web/src/routes.ts web/src/routes.test.ts web/src/use-is-narrow.ts web/src/components/agents/ web/src/components/common/drawer.tsx web/src/App.tsx web/src/api.ts
git commit -m "feat(web): subagent panel + detail view + drawer + hash router"
```

---

### Task 11: Sessions view + management

**Files:**
- Create: `web/src/components/sessions/list.tsx`
- Modify: `web/src/App.tsx` (route `#/sessions`)
- Test: `web/src/api.test.ts` (session CRUD already stubbed in Task 8 — add coverage here)

**Interfaces:**
- Consumes: `api.listSessions/renameSession/deleteSession`, `state`.
- Produces: `SessionList` component — list with title/updatedAt/messageCount, `···` menu (continue → `#/` + POST /api/sessions resume), rename (inline prompt), delete (confirm), `[+ 新建]` (POST /api/sessions {} → `#/`).

- [ ] **Step 1: Write the failing api test for session CRUD** (append to `web/src/api.test.ts`):

```ts
test('deleteSession POSTs the id and resolves', async () => {
  let body: string | undefined;
  globalThis.fetch = async (_url: any, init: any) => {
    body = init.body;
    return new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } }) as any;
  };
  await deleteSession('s1');
  assert.equal(body, JSON.stringify({ id: 's1' }));
});
```

- [ ] **Step 2: Run to verify (deleteSession imported) — then implement `web/src/components/sessions/list.tsx`**

```tsx
import { createEffect, createSignal, For, Show } from 'solid-js';
import { listSessions, renameSession, deleteSession } from '../../api.ts';

interface SessionRow { id: string; title: string; updatedAt: string; messageCount: number }

export function SessionList() {
  const [sessions, setSessions] = createSignal<SessionRow[]>([]);
  const [menuFor, setMenuFor] = createSignal<string | null>(null);
  const [confirmDelete, setConfirmDelete] = createSignal<string | null>(null);
  const [renaming, setRenaming] = createSignal<string | null>(null);
  const [draft, setDraft] = createSignal('');

  const refresh = () => void listSessions().then(setSessions).catch(() => {});
  createEffect(refresh);

  const resume = (id: string) => {
    void fetch('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) }).then(() => { location.hash = '#/'; });
  };
  const newSession = () => {
    void fetch('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(() => { location.hash = '#/'; });
  };
  const doRename = async (id: string) => {
    const t = draft().trim();
    if (t) { await renameSession(id, t); refresh(); }
    setRenaming(null);
  };
  const doDelete = async (id: string) => {
    await deleteSession(id);
    setConfirmDelete(null);
    refresh();
  };

  return (
    <div class="sessions">
      <header class="sessions-topbar">
        <a class="back" href="#/">← 返回</a>
        <h2>会话</h2>
        <button class="new-btn" onClick={newSession}>[+ 新建]</button>
      </header>
      <ul class="session-list">
        <For each={sessions()}>
          {(s) => (
            <li class="session-row">
              <button class="session-title" onClick={() => resume(s.id)}>{s.title}</button>
              <span class="session-meta">{new Date(s.updatedAt).toLocaleString()} · {s.messageCount} 条</span>
              <button class="session-menu" onClick={() => setMenuFor(menuFor() === s.id ? null : s.id)}>···</button>
              <Show when={menuFor() === s.id}>
                <div class="session-menu-pop">
                  <button onClick={() => { setRenaming(s.id); setDraft(s.title); setMenuFor(null); }}>重命名</button>
                  <button onClick={() => { setConfirmDelete(s.id); setMenuFor(null); }}>删除</button>
                </div>
              </Show>
              <Show when={renaming() === s.id}>
                <input value={draft()} onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void doRename(s.id); if (e.key === 'Escape') setRenaming(null); }} />
              </Show>
              <Show when={confirmDelete() === s.id}>
                <div class="confirm-delete">
                  确认删除「{s.title}」？
                  <button onClick={() => void doDelete(s.id)}>删除</button>
                  <button onClick={() => setConfirmDelete(null)}>取消</button>
                </div>
              </Show>
            </li>
          )}
        </For>
      </ul>
    </div>
  );
}
```

- [ ] **Step 3: Route `#/sessions` in `App.tsx`** (already wired in Task 10's router: `route().route === 'sessions'` → `<SessionList />`; import from `./components/sessions/list.tsx`).

- [ ] **Step 4: Run web tests + typecheck**

Run: `node --test --experimental-transform-types web/src/*.test.ts` and `npm run typecheck`
Expected: pass + clean.

- [ ] **Step 5: Manual smoke**

Run: `npm run dev` → `#/sessions` lists real sessions (CLI/TUI sessions interoperate); continue/rename/delete all work; new session starts a fresh `#/`.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/sessions/list.tsx web/src/App.tsx web/src/api.test.ts
git commit -m "feat(web): session list + manage (continue/rename/delete/new)"
```

---

### Task 12: Polish — styles, reconnect banner, config sync, README

**Files:**
- Modify: `web/src/styles.css` (full layout: topbar, chat stream, subagents panel, drawer, badges, tool cards, permission card, input, sessions)
- Modify: `web/src/stores.ts` (expose `setAutoApproveLocal` so the toggle updates UI immediately)
- Modify: `web/src/App.tsx` (reconnect banner, load config on mount, permission card rendering into the stream)
- Modify: `README.md` (Web UI section: `daedalus web`, URLs, mobile/desktop, session interop, deprecation note for TUI/REPL)

**Interfaces:**
- Consumes: everything from Tasks 8–11.
- Produces: production-shaped styles + reconnect/status UX; README documents the new entry.

- [ ] **Step 1: Add `setAutoApproveLocal` to `web/src/stores.ts`**

```ts
export function setAutoApproveLocal(v: boolean): void {
  setState((s) => ({ ...s, autoApprove: v }));
}
```

- [ ] **Step 2: `App.tsx` — load config on mount, reconnect banner, auto toggle wires local+server**

```tsx
import { createSignal, createEffect, Show } from 'solid-js';
import { state, setAutoApproveLocal } from './stores.ts';
import { getConfig, putConfig } from './api.ts';

// inside App():
createEffect(() => { void getConfig().then((c) => setAutoApproveLocal(c.autoApprove)).catch(() => {}); });

const onToggleAuto = async () => {
  const next = !state().autoApprove;
  setAutoApproveLocal(next);
  await putConfig({ autoApprove: next }).catch(() => {});
};

// banner: <Show when={wsStatus() !== 'open'}><div class="reconnect-banner">连接断开，重连中…</div></Show>
```

- [ ] **Step 3: Write `web/src/styles.css`** — complete the responsive layout:

```css
/* layout: topbar / main (chat-stream + subagents-panel) / chat-input */
.app { height: 100%; display: flex; flex-direction: column; }
.topbar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid #333; background: #161616; }
.main { flex: 1; display: flex; overflow: hidden; }
.chat-stream { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.subagents-panel { width: 280px; border-left: 1px solid #333; padding: 12px; overflow-y: auto; }
@media (max-width: 1023px) { .subagents-panel { display: none; } }
.chat-input { display: flex; gap: 8px; padding: 10px 12px; border-top: 1px solid #333; align-items: flex-end; background: #161616; }
.chat-input textarea { flex: 1; resize: none; background: #222; color: #eee; border: 1px solid #444; border-radius: 8px; padding: 8px 10px; min-height: 40px; }
.send-btn { width: 40px; height: 40px; border-radius: 8px; border: none; background: #2a7de1; color: #fff; font-size: 18px; }
.auto-toggle { height: 40px; padding: 0 10px; border-radius: 8px; border: 1px solid #444; background: #222; color: #ccc; }
.auto-toggle.auto-on { border-color: #2a7de1; color: #2a7de1; }

/* messages / thinking / tool cards / permission / badges / delegate rows */
.msg { padding: 8px 10px; border-radius: 10px; max-width: 85%; }
.msg-user { align-self: flex-end; background: #1d4a8f; color: #fff; white-space: pre-wrap; }
.msg-assistant { align-self: flex-start; background: #1d1d1d; }
.msg-text { white-space: pre-wrap; word-break: break-word; }
.thinking { background: #1a1a1a; color: #999; border-left: 2px solid #555; padding: 4px 8px; cursor: pointer; border-radius: 4px; }
.thinking-toggle { font-size: 12px; color: #888; }
.thinking-body { margin-top: 6px; white-space: pre-wrap; color: #aaa; }
.tool-card { border: 1px solid #444; border-left: 3px solid #2a7de1; border-radius: 6px; padding: 6px 10px; cursor: pointer; background: #181818; }
.tool-card.error { border-left-color: #e5484d; }
.tool-card.done { border-left-color: #46a758; }
.tool-title { font-weight: 600; margin-right: 8px; }
.tool-input-preview { color: #888; font-size: 12px; }
.tool-body { margin-top: 8px; }
.tool-content { white-space: pre-wrap; background: #111; padding: 8px; border-radius: 6px; max-height: 320px; overflow: auto; font-size: 12px; }
.diff { background: #111; padding: 8px; border-radius: 6px; font-size: 12px; overflow-x: auto; }
.diff-add { color: #46a758; }
.diff-del { color: #e5484d; }
.permission-card { border: 1px solid #e5a50a; border-left: 3px solid #e5a50a; border-radius: 6px; padding: 10px; background: #201a08; }
.permission-title { font-weight: 600; color: #f0d77a; }
.permission-target { white-space: pre-wrap; background: #111; padding: 6px; border-radius: 4px; margin: 8px 0; font-size: 12px; }
.permission-btns button { margin-right: 8px; padding: 6px 12px; border-radius: 6px; border: none; cursor: pointer; }
.permission-btns button:first-child { background: #46a758; color: #fff; }
.delegate-row { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 6px; text-decoration: none; color: inherit; }
.delegate-row:hover { background: #1d1d1d; }
.delegate-name { font-weight: 600; }
.delegate-task { color: #888; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.event-line { color: #666; font-size: 12px; padding: 2px 8px; }

/* badge / drawer / sessions / agent detail / reconnect banner */
.badge { font-size: 11px; padding: 2px 8px; border-radius: 10px; border: 1px solid #444; }
.badge-running { color: #2a7de1; border-color: #2a7de1; }
.badge-done { color: #46a758; border-color: #46a758; }
.badge-error { color: #e5484d; border-color: #e5484d; }
.badge-queued { color: #aaa; border-color: #aaa; }
.drawer-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.5); z-index: 10; }
.drawer { position: fixed; top: 0; left: 0; bottom: 0; width: 280px; background: #161616; z-index: 11; padding: 12px; overflow-y: auto; }
.ws-dot { width: 8px; height: 8px; border-radius: 50%; background: #e5484d; }
.ws-dot.open { background: #46a758; }
.reconnect-banner { background: #3a2a00; color: #f0d77a; padding: 4px 12px; text-align: center; font-size: 12px; }
.sessions { height: 100%; overflow-y: auto; padding: 12px; }
.session-list { list-style: none; padding: 0; margin: 0; }
.session-row { border-bottom: 1px solid #333; padding: 10px 4px; display: flex; align-items: center; gap: 10px; }
.session-title { flex: 1; text-align: left; background: none; border: none; color: #eee; cursor: pointer; font-size: 15px; }
.session-meta { color: #666; font-size: 12px; }
.agent-detail { height: 100%; overflow-y: auto; padding: 12px; }
.agent-meta { display: flex; gap: 8px; align-items: center; margin: 8px 0; }
.agent-interaction { margin-top: 24px; border-top: 1px dashed #333; padding-top: 12px; color: #555; font-size: 12px; }
```

- [ ] **Step 4: Run full test suite + typecheck**

Run: `npm test` and `npm run typecheck`
Expected: all existing daedalus tests pass + web tests pass; tsc clean (both root + web).

- [ ] **Step 5: Update README.md** — add a "Web UI" section:

```md
## Web UI

`daedalus web [--port 3100]` starts a standalone web UI (mobile-first, desktop-parity).

- Open http://localhost:3100 (or the printed LAN URL) in a browser.
- Main chat with streaming, thinking, tool cards, inline permission cards (ask ↔ auto toggle).
- Subagents panel (drawer on narrow screens) → click an agent for its detail view.
- `#/sessions` for session management (continue / rename / delete / new).
- Sessions share `~/.daedalus/sessions` with the CLI/TUI — they interoperate.

The web UI is the primary interface going forward; the terminal TUI/REPL are
retained for now and will be removed once the web UI matures.
```

- [ ] **Step 6: Final manual smoke on phone + desktop**

Run: `npm run build` (tsc + vite build) → `node dist/cli/main.js web --port 3100`
Expected: production build serves; LAN URL works on a phone; full conversation + tool + permission + subagent + session flows pass.

- [ ] **Step 7: Commit**

```bash
git add web/src/styles.css web/src/stores.ts web/src/App.tsx README.md
git commit -m "feat(web): polish — responsive styles, reconnect banner, config sync, README"
```

---

## Self-Review Notes

- **Spec coverage:** §4 (architecture) → Tasks 3–8; §5 (ws protocol) → Tasks 5, 8; §6.1–6.3 (main chat) → Tasks 8–10; §6.2 (subagent detail) → Task 10; §6.4 (sessions) → Task 11; §7 (SessionStore title/rename) → Task 2; §8 (permission) → Task 5 + Task 9 card; §9 (REST) → Task 6; §10 (run modes/scripts) → Tasks 1, 7, 12; §11 (tests) → spread across tasks; §12 (deps) → Task 1.
- **Placeholders:** none — every code step carries full implementation.
- **Type consistency:** `EventEnvelope`/`SnapshotPayload`/`UiState`/`SubagentInfo` defined once (Task 8) and reused; `sendWsMessage` exported from `ws.ts` (Task 8) and consumed by `PermissionCard` (Task 9); `setAutoApproveLocal` (Task 12) consumed by App; `parseHash` (Task 10) used in App router.
