import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { HttpServer } from '../../src/server/http.ts';
import { WebSocketHub } from '../../src/server/ws.ts';
import { EventHub } from '../../src/server/event-hub.ts';
import { WebPermissionManager } from '../../src/server/permission.ts';

/**
 * PRE-FLIGHT RULING：collector 必须在连接建立前挂上 —— 服务端在握手回调里同步发
 * snapshot，晚于 'open' 再挂 listener 会漏掉首条消息。这里在构造 ws 的同时启动
 * 收集器，nextMessage 按 type 从队列取（而非一次性 on('message')）。
 */
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

function connect(hub: WebSocketHub, http: HttpServer): Promise<WebSocket> {
  return http.listen(0, '127.0.0.1').then(() => {
    const { port } = http.address() as { port: number };
    return new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`);
      startCollector(ws); // 先挂收集器，再等 open
      ws.on('open', () => resolve(ws));
      ws.on('error', reject);
    });
  });
}

/** 按 type 等待下一条消息；已到的先从队列取，否则挂 waiter 等待。 */
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

function fakeEngine() {
  return {
    getSessionState: () => ({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], loadedSkills: [] }),
    listSubagents: () => [],
    getSubagentMessages: () => [],
  };
}

test('sends snapshot on connect with current messages + subagents + running', async () => {
  const http = new HttpServer({ staticDir: process.cwd() }); // static unused
  const hub = new WebSocketHub({ engine: fakeEngine() as any, hub: new EventHub(), permission: new WebPermissionManager() });
  hub.attach(http);
  let ws: WebSocket | undefined;
  try {
    ws = await connect(hub, http);
    const msg = await nextMessage(ws, 'snapshot');
    assert.equal(msg.type, 'snapshot');
    assert.equal(msg.messages.length, 1);
    assert.equal(msg.running, false);
  } finally {
    ws?.close();
    await http.close();
  }
});

test('broadcasts engine events as event messages to clients', async () => {
  const http = new HttpServer({ staticDir: process.cwd() });
  const hub = new WebSocketHub({ engine: fakeEngine() as any, hub: new EventHub(), permission: new WebPermissionManager() });
  hub.attach(http);
  let ws: WebSocket | undefined;
  try {
    ws = await connect(hub, http);
    await nextMessage(ws, 'snapshot');
    hub.broadcastEvent({ type: 'text_delta', text: 'hello' });
    const msg = await nextMessage(ws, 'event');
    assert.equal(msg.type, 'event');
    assert.equal(msg.ev.text, 'hello');
  } finally {
    ws?.close();
    await http.close();
  }
});

test('replays in-flight log events after snapshot', async () => {
  const http = new HttpServer({ staticDir: process.cwd() });
  const hub = new WebSocketHub({ engine: fakeEngine() as any, hub: new EventHub(), permission: new WebPermissionManager() });
  hub.broadcastEvent({ type: 'tool_call_start', id: '1', name: 'bash' }); // mark in-flight log before any client
  hub.attach(http);
  let ws: WebSocket | undefined;
  try {
    ws = await connect(hub, http);
    const first = await nextMessage(ws, 'snapshot');
    assert.equal(first.running, true);
    assert.equal(first.log.length, 1);
    const replayed = await nextMessage(ws, 'event');
    assert.equal(replayed.ev.name, 'bash');
  } finally {
    ws?.close();
    await http.close();
  }
});
