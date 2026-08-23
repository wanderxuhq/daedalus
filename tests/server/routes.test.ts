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
    injectSubagentMessage: () => {},
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

// 与 brief 的偏差：brief 版签名是 withRoutes(t, ...) 但 t 从未被使用、测试回调也没传，
// 直接照抄会 ReferenceError（T5 racing helper 同类问题）。最小修复：删掉该参数。
async function withRoutes(engine, store, hub, fn) {
  const http = new HttpServer({ staticDir: process.cwd() });
  registerAll(http, { engine: engine as any, store: store as any, hub: hub as any });
  await http.listen(0, '127.0.0.1');
  const { port } = http.address() as { port: number };
  const base = `http://127.0.0.1:${port}`;
  try { await fn(base); } finally { await http.close(); }
}

test('POST /api/chat runs the engine and returns the result', async () => {
  const engine = fakeEngine();
  await withRoutes(engine, fakeStore(), {}, async (base) => {
    const res = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'hi' }) });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'ok', result: 'ok:hi' });
  });
});

test('POST /api/chat returns 409 while a run is in flight', async () => {
  let release!: () => void;
  const engine = fakeEngine({});
  // 与 brief 的偏差：brief 用 never-resolving 的 run()，导致第一条请求永不返回、
  // http.close() 死锁、测试挂死。最小修复：用可释放的 deferred——先断言 409，
  // 再放行第一条 run() 让服务器能干净关闭。断言不变（仍是并发第二个请求 → 409）。
  engine.run = () => new Promise<string>((res) => { release = () => res('ok:a'); }) as any;
  await withRoutes(engine, fakeStore(), {}, async (base) => {
    const first = fetch(`${base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'a' }) });
    await new Promise((r) => setTimeout(r, 20)); // let the first run start
    const second = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'b' }) });
    assert.equal(second.status, 409);
    release();
    assert.equal((await first).status, 200); // the in-flight request still completes
  });
});

test('GET /api/sessions returns titles from the store', async () => {
  const store = fakeStore({ sessions: [{ id: 's1', updatedAt: '2026-01-01', title: 'Hello', messageCount: 3 }] });
  await withRoutes(fakeEngine(), store, {}, async (base) => {
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
  await withRoutes(fakeEngine(), store, {}, async (base) => {
    const res = await fetch(`${base}/api/sessions/rename`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 's1', title: 'New' }) });
    assert.equal(res.status, 200);
    assert.deepEqual(renamed, { id: 's1', title: 'New' });
  });
});

test('POST /api/agents/chat injects a message into a subagent session', async () => {
  let injected: { name: string; prompt: string } | null = null;
  const engine = fakeEngine();
  engine.injectSubagentMessage = (name: string, prompt: string) => { injected = { name, prompt }; };
  await withRoutes(engine, fakeStore(), {}, async (base) => {
    const res = await fetch(`${base}/api/agents/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'worker', prompt: 'do it' }) });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'ok' });
    assert.deepEqual(injected, { name: 'worker', prompt: 'do it' });
  });
});

test('POST /api/agents/chat returns 400 without name or prompt', async () => {
  const engine = fakeEngine();
  await withRoutes(engine, fakeStore(), {}, async (base) => {
    const noName = await fetch(`${base}/api/agents/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'hi' }) });
    assert.equal(noName.status, 400);
    const noPrompt = await fetch(`${base}/api/agents/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'w' }) });
    assert.equal(noPrompt.status, 400);
  });
});



test('GET /api/config returns engine state; PUT /api/config toggles autoApprove', async () => {
  let auto = false;
  const engine = fakeEngine({ autoApprove: false });
  engine.setAutoApprove = (v: boolean) => { auto = v; };
  engine.getAutoApprove = () => auto;
  await withRoutes(engine, fakeStore(), {}, async (base) => {
    const cfg = await (await fetch(`${base}/api/config`)).json();
    assert.equal(cfg.autoApprove, false);
    const put = await fetch(`${base}/api/config`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ autoApprove: true }) });
    assert.equal(put.status, 200);
    const cfg2 = await (await fetch(`${base}/api/config`)).json();
    assert.equal(cfg2.autoApprove, true);
  });
});
