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
