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
    injectSubagentMessage: () => {},
  };
  const srv = buildServer({ engine: engineStub as any, store, staticDir: process.cwd() });
  await srv.listen(0, '127.0.0.1');
  const { port } = srv.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${port}/api/config`);
  assert.equal(res.status, 200);
  await srv.close();
});

test('buildServer wires engine events to ws and permission round-trip', async () => {
  const { buildServer } = await import('../../src/server/server.ts');
  const { WebSocketHub } = await import('../../src/server/ws.ts');
  const { WebPermissionManager } = await import('../../src/server/permission.ts');
  const { mkdtempSync } = await import('node:fs');

  let subscribed: ((ev: unknown) => void) | undefined;
  let installedAsk: ((action: string, target: string) => Promise<boolean>) | undefined;
  let autoApprove = false;
  const engineStub = {
    subscribe: (h: (ev: unknown) => void) => { subscribed = h; return () => {}; },
    setAskPermission: (ask: (action: string, target: string) => Promise<boolean>) => { installedAsk = ask; },
    getAutoApprove: () => autoApprove,
    setAutoApprove: (v: boolean) => { autoApprove = v; },
    injectSubagentMessage: () => {},
    run: async (p: string) => `ok:${p}`,
    getSessionState: () => ({ messages: [], loadedSkills: [] }),
    listSubagents: () => [],
  };
  const srv = buildServer({
    engine: engineStub as any,
    store: new (await import('../../src/core/session-store.ts')).SessionStore(mkdtempSync(join(tmpdir(), 'dae-srv-'))),
    staticDir: process.cwd(),
  });

  // engine.subscribe was called (events → ws broadcast)
  assert.equal(typeof subscribed, 'function', 'engine.subscribe must be wired');
  assert.ok(srv.hub instanceof WebSocketHub, 'hub is a WebSocketHub');
  assert.ok(srv.permission instanceof WebPermissionManager);

  // permission.ask must be installed on the engine AND broadcasting to ws
  assert.equal(typeof installedAsk, 'function', 'engine.setAskPermission(permission.ask) must be wired');
  const seen: unknown[] = [];
  srv.hub.broadcast = (msg: unknown) => seen.push(msg);
  const pending = installedAsk!('bash', 'ls -la');
  assert.deepEqual(srv.permission.pending(), { id: 'p1', action: 'bash', target: 'ls -la' });
  assert.deepEqual(seen, [{ type: 'permission', id: 'p1', action: 'bash', target: 'ls -la' }]);
  srv.permission.settle('p1', true, false);
  assert.equal(await pending, true);

  // subscribed handler feeds broadcastEvent: hub.handle tracks subagents
  subscribed!({ type: 'delegate_start', agent: 'scout', task: 'explore' });
  // Subagent events are broadcast but NOT in the main log (they don't affect running state)
  assert.equal((srv.hub as any).log.length, 0, 'subagent events are not in the main log (tracked by EventHub instead)');
  assert.equal(srv.permission.pending(), null);

  await srv.close();
});

test('staticDirFor resolves <module dir>/../web and lanIPv4 never throws', async () => {
  const { staticDirFor, lanIPv4 } = await import('../../src/server/static.ts');
  const { pathToFileURL } = await import('node:url');
  // 源码布局：src/server/static.ts → <root>/web
  assert.equal(
    staticDirFor(pathToFileURL(join(process.cwd(), 'src/server/static.ts')).href),
    join(process.cwd(), 'web'),
  );
  // 产物布局：dist/server/static.js → <root>/dist/web
  assert.equal(
    staticDirFor(pathToFileURL(join(process.cwd(), 'dist/server/static.js')).href),
    join(process.cwd(), 'dist/web'),
  );
  const lan = lanIPv4();
  assert.ok(lan === null || (/^\d+\.\d+\.\d+\.\d+$/.test(lan) && lan !== '127.0.0.1'));
});
