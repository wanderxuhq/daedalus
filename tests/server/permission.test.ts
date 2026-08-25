import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { HttpServer } from '../../src/server/http.ts';
import { WebSocketHub } from '../../src/server/ws.ts';
import { EventHub } from '../../src/server/event-hub.ts';
import { WebPermissionManager } from '../../src/server/permission.ts';
import type { CoreEvent } from '../../src/core/events.ts';

// ---------------------------------------------------------------------------
// Helpers (copied from ws.test.ts conventions)
// ---------------------------------------------------------------------------

const queues = new WeakMap<WebSocket, any[]>();
const waiters = new WeakMap<WebSocket, Array<{ type: string; resolve: (m: any) => void; reject: (e: Error) => void }>>();

function startCollector(ws: WebSocket): void {
  queues.set(ws, []);
  waiters.set(ws, []);
  ws.on('message', (data) => {
    let parsed: any;
    try { parsed = JSON.parse(data.toString()); } catch { return; }
    const q = queues.get(ws)!;
    const wq = waiters.get(ws)!;
    const idx = wq.findIndex((w) => w.type === parsed?.type);
    if (idx >= 0) {
      const w = wq[idx];
      wq.splice(idx, 1);
      w.resolve(parsed);
    } else {
      q.push(parsed);
    }
  });
}

function fakeEngine() {
  return {
    getSessionState: () => ({
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'You are Daedalus' }] },
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      ],
      loadedSkills: [],
    }),
    listSubagents: () => [],
    getSubagentMessages: () => [],
  };
}

async function connect(hub: WebSocketHub, http: HttpServer): Promise<WebSocket> {
  await http.listen(0, '127.0.0.1');
  const { port } = http.address() as { port: number };
  return new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`);
    startCollector(ws);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

async function nextMessage(ws: WebSocket, type: string, timeoutMs = 1000): Promise<any> {
  const q = queues.get(ws)!;
  const i = q.findIndex((m) => m?.type === type);
  if (i >= 0) return q.splice(i, 1)[0];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const wq = waiters.get(ws)!;
      const idx = wq.findIndex((w) => w.resolve === resolve);
      if (idx >= 0) wq.splice(idx, 1);
      reject(new Error(`timeout waiting for ${type}`));
    }, timeoutMs);
    waiters.get(ws)!.push({ type, resolve, reject });
  });
}

function doneEvent(): CoreEvent {
  return { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } };
}

function errorEvent(): CoreEvent {
  return { type: 'error', error: { message: 'boom', code: 'ERR' } };
}

/** Race a promise against a timeout; returns { settled: true, value } or { settled: false }. */
async function raceTimeout<T>(promise: Promise<T>, ms = 100): Promise<{ settled: boolean; value?: T }> {
  return Promise.race([
    promise.then((v) => ({ settled: true, value: v })),
    new Promise<{ settled: boolean }>((r) => setTimeout(() => r({ settled: false }), ms)),
  ]);
}

// ---------------------------------------------------------------------------
// Unit tests: WebPermissionManager
// ---------------------------------------------------------------------------

test('permission.ask broadcasts request to clients via setBroadcast', () => {
  const perm = new WebPermissionManager();
  const sent: unknown[] = [];
  perm.setBroadcast((msg) => sent.push(msg));

  const promise = perm.ask('bash', 'rm -rf /');

  assert.equal(typeof promise.then, 'function', 'ask() returns a thenable');
  assert.deepEqual(perm.pending(), { id: 'p1', action: 'bash', target: 'rm -rf /' });
  assert.deepEqual(sent, [{ type: 'permission', id: 'p1', action: 'bash', target: 'rm -rf /' }]);
});

test('permission.settle resolves the pending promise with the allow value', async () => {
  const perm = new WebPermissionManager();
  perm.setBroadcast(() => {});

  const promise = perm.ask('file_write', '/etc/passwd');

  // Not yet resolved
  let resolved = false;
  promise.then(() => { resolved = true; });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(resolved, false, 'promise should not be resolved before settle');

  perm.settle('p1', true, false);
  assert.equal(await promise, true);
  assert.equal(perm.pending(), null, 'pending should be cleared after settle');
});

test('permission.settle with always=true activates auto-approve', async () => {
  let autoApprove = false;
  const perm = new WebPermissionManager({
    engine: {
      getAutoApprove: () => autoApprove,
      setAutoApprove: (v: boolean) => { autoApprove = v; },
    },
  });
  perm.setBroadcast(() => {});

  perm.ask('bash', 'ls');
  perm.settle('p1', true, true);

  assert.equal(autoApprove, true, 'autoApprove should be set after always=true settle');
  // Next ask should short-circuit
  const result = await perm.ask('bash', 'rm');
  assert.equal(result, true, 'auto-approve should resolve immediately');
});

test('permission.clearAll resolves all pending promises with false', async () => {
  const perm = new WebPermissionManager();
  perm.setBroadcast(() => {});

  const p1 = perm.ask('bash', 'cmd1');
  const p2 = perm.ask('bash', 'cmd2');
  assert.equal(perm.pending()!.action, 'bash', 'first pending should be bash');

  perm.clearAll();

  assert.equal(await p1, false, 'first promise should resolve false');
  assert.equal(await p2, false, 'second promise should resolve false');
  assert.equal(perm.pending(), null, 'no pending after clearAll');
});

test('permission.ask auto-rejects after timeout to prevent engine hang', async () => {
  // Use a very short timeout for testing
  const perm = new WebPermissionManager({ timeoutMs: 50 });
  perm.setBroadcast(() => {});

  const promise = perm.ask('bash', 'sleep 999');

  // Wait for timeout to trigger
  const result = await raceTimeout(promise, 100);
  assert.equal(result.settled, true, 'permission promise should resolve after timeout');
  assert.equal(result.value, false, 'permission should auto-reject after timeout');
});

// ---------------------------------------------------------------------------
// Integration tests: WebSocketHub + permission + client disconnect
// ---------------------------------------------------------------------------

test('permission request is broadcast to connected WebSocket clients', async () => {
  const http = new HttpServer({ staticDir: process.cwd() });
  const hub = new WebSocketHub({ engine: fakeEngine() as any, hub: new EventHub(), permission: new WebPermissionManager() });
  hub.attach(http);
  let ws: WebSocket | undefined;
  try {
    ws = await connect(hub, http);
    await nextMessage(ws, 'snapshot'); // drain initial snapshot

    // Trigger a permission request
    hub.permission.setBroadcast((msg) => hub.broadcast(msg));
    const pending = hub.permission.ask('bash', 'whoami');

    // Client should receive the permission request
    const msg = await nextMessage(ws, 'permission');
    assert.equal(msg.type, 'permission');
    assert.equal(msg.id, 'p1');
    assert.equal(msg.action, 'bash');
    assert.equal(msg.target, 'whoami');

    // Respond to complete the test cleanly
    ws.send(JSON.stringify({ type: 'permission', id: 'p1', allow: true }));
    assert.equal(await pending, true);
  } finally {
    ws?.close();
    await http.close();
  }
});

test('client disconnect: permission auto-rejects after timeout', async () => {
  const http = new HttpServer({ staticDir: process.cwd() });
  // Use short timeout for testing
  const permission = new WebPermissionManager({ timeoutMs: 50 });
  const hub = new WebSocketHub({ engine: fakeEngine() as any, hub: new EventHub(), permission });
  hub.attach(http);
  let ws: WebSocket | undefined;
  try {
    ws = await connect(hub, http);
    await nextMessage(ws, 'snapshot');

    // Wire broadcast so permission.ask pushes to connected clients
    permission.setBroadcast((msg) => hub.broadcast(msg));

    // Issue a permission request -- engine awaits this promise
    const promise = permission.ask('bash', 'dangerous command');
    // Client receives the request
    await nextMessage(ws, 'permission');

    // Client disconnects WITHOUT responding
    ws.close();
    await new Promise((r) => setTimeout(r, 100)); // let close propagate

    // Permission should auto-reject after timeout (not hang indefinitely)
    const result = await raceTimeout(promise, 200);
    assert.equal(result.settled, true, 'permission promise resolves after timeout');
    assert.equal(result.value, false, 'permission auto-rejects after timeout');
    assert.equal(permission.pending(), null, 'pending map cleared after timeout');
  } finally {
    ws?.close();
    await http.close();
  }
});

test('terminal event (done) after client disconnect unblocks pending permission via clearAll', async () => {
  const http = new HttpServer({ staticDir: process.cwd() });
  const permission = new WebPermissionManager();
  const hub = new WebSocketHub({ engine: fakeEngine() as any, hub: new EventHub(), permission });
  hub.attach(http);
  let ws: WebSocket | undefined;
  try {
    ws = await connect(hub, http);
    await nextMessage(ws, 'snapshot');
    permission.setBroadcast((msg) => hub.broadcast(msg));

    // Issue permission and let client disconnect
    const promise = permission.ask('bash', 'hang forever');
    await nextMessage(ws, 'permission');
    ws.close();
    await new Promise((r) => setTimeout(r, 100));

    // Now emit a terminal event -- this calls broadcastEvent -> clearAll
    hub.broadcastEvent(doneEvent());

    // The permission promise should now be resolved
    assert.equal(await promise, false, 'permission should resolve false after terminal event triggers clearAll');
    assert.equal(permission.pending(), null, 'pending map should be empty');
  } finally {
    ws?.close();
    await http.close();
  }
});

test('terminal event (error) also clears pending permissions', async () => {
  const permission = new WebPermissionManager();
  permission.setBroadcast(() => {});

  const promise = permission.ask('file_write', '/etc/shadow');

  const hub = new WebSocketHub({
    engine: fakeEngine() as any,
    hub: new EventHub(),
    permission,
  });

  hub.broadcastEvent(errorEvent());

  assert.equal(await promise, false, 'permission should resolve false on error event');
  assert.equal(permission.pending(), null);
});

test('non-terminal events do NOT clear pending permissions', async () => {
  const permission = new WebPermissionManager();
  permission.setBroadcast(() => {});

  const promise = permission.ask('bash', 'important');

  const hub = new WebSocketHub({
    engine: fakeEngine() as any,
    hub: new EventHub(),
    permission,
  });

  // Emit a non-terminal event (turn_done)
  hub.broadcastEvent({ type: 'turn_done', message: { role: 'assistant', content: [{ type: 'text', text: 'partial' }] } } as any);

  // Permission should still be pending
  const result = await raceTimeout(promise, 100);
  assert.equal(result.settled, false, 'turn_done should not clear pending permissions');
  assert.notEqual(permission.pending(), null);
});

test('reconnecting client sees pending permission in snapshot and can respond', async () => {
  const http = new HttpServer({ staticDir: process.cwd() });
  const permission = new WebPermissionManager();
  const hub = new WebSocketHub({ engine: fakeEngine() as any, hub: new EventHub(), permission });
  hub.attach(http);
  permission.setBroadcast((msg) => hub.broadcast(msg));

  let ws1: WebSocket | undefined;
  let ws2: WebSocket | undefined;
  try {
    // First client connects
    ws1 = await connect(hub, http);
    await nextMessage(ws1, 'snapshot');

    // Permission request issued
    const promise = permission.ask('bash', 'secret');
    await nextMessage(ws1, 'permission');

    // First client disconnects
    ws1.close();
    await new Promise((r) => setTimeout(r, 100));

    // Second client connects -- snapshot should include pending permission
    const { port } = http.address() as { port: number };
    ws2 = new WebSocket(`ws://127.0.0.1:${port}/api/ws`);
    startCollector(ws2);
    await new Promise<void>((resolve) => ws2!.on('open', () => resolve()));

    const snap = await nextMessage(ws2, 'snapshot');
    assert.ok(snap.pendingPermission !== null, 'reconnecting client should see pending permission in snapshot');
    assert.equal(snap.pendingPermission.id, 'p1');
    assert.equal(snap.pendingPermission.action, 'bash');
    assert.equal(snap.pendingPermission.target, 'secret');

    // Second client can respond
    ws2.send(JSON.stringify({ type: 'permission', id: 'p1', allow: true }));
    assert.equal(await promise, true, 'permission resolves when new client responds');
    assert.equal(permission.pending(), null);
  } finally {
    ws1?.close();
    ws2?.close();
    await http.close();
  }
});

test('snapshot includes pendingPermission when a permission is outstanding', async () => {
  const http = new HttpServer({ staticDir: process.cwd() });
  const permission = new WebPermissionManager();
  const hub = new WebSocketHub({ engine: fakeEngine() as any, hub: new EventHub(), permission });
  hub.attach(http);
  permission.setBroadcast((msg) => hub.broadcast(msg));

  let ws: WebSocket | undefined;
  try {
    ws = await connect(hub, http);

    // First snapshot: no pending permission
    const snap1 = await nextMessage(ws, 'snapshot');
    assert.equal(snap1.pendingPermission, null, 'no pending permission initially');

    // Issue permission
    permission.ask('bash', 'whoami');

    // Reconnect to get updated snapshot
    ws.close();
    await new Promise((r) => setTimeout(r, 100));

    const { port } = http.address() as { port: number };
    ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`);
    startCollector(ws);
    await new Promise<void>((resolve) => ws.on('open', () => resolve()));

    const snap2 = await nextMessage(ws, 'snapshot');
    assert.ok(snap2.pendingPermission !== null, 'snapshot should contain pending permission');
    assert.equal(snap2.pendingPermission.action, 'bash');
  } finally {
    ws?.close();
    await http.close();
  }
});

// ---------------------------------------------------------------------------
// Key finding summary test: the engine recovery question
// ---------------------------------------------------------------------------

test('engine recovery: clearAll prevents hang on terminal event', async () => {
  // Simulates the full lifecycle:
  // 1. Engine asks permission (blocks on promise)
  // 2. Client disconnects (no response)
  // 3. Engine emits terminal event externally (e.g., abort/cancel)
  // 4. broadcastEvent -> clearAll -> promise resolves with false
  const permission = new WebPermissionManager({ timeoutMs: 60_000 }); // long timeout
  permission.setBroadcast(() => {});

  const hub = new WebSocketHub({
    engine: fakeEngine() as any,
    hub: new EventHub(),
    permission,
  });

  // Simulate: engine calls ask(), blocks on the promise
  const engineBlocked = permission.ask('bash', 'dangerous');

  // Verify the promise hangs (before timeout)
  const stillPending = await raceTimeout(engineBlocked, 50);
  assert.equal(stillPending.settled, false, 'engine would be stuck here');

  // Simulate: external abort triggers terminal event -> clearAll
  hub.broadcastEvent(doneEvent());

  // Engine unblocks
  assert.equal(await engineBlocked, false, 'engine unblocks with false (denied)');
});
