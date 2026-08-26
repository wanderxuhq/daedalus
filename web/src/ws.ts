import type { EventEnvelope } from './types.ts';

export type WsStatus = 'connecting' | 'open' | 'closed';

/** 当前活动连接的发送函数；未连接时发送被忽略（权限卡点击安全兜底）。 */
let activeSend: ((raw: string) => void) | null = null;

/** 当前 WebSocket 实例引用，用于主动断开触发重连。 */
let currentWs: WebSocket | null = null;

export function sendWsMessage(msg: unknown): void {
  if (activeSend) activeSend(JSON.stringify(msg));
}

/**
 * 主动断开 WebSocket 并触发自动重连（指数退避从 1s 重新开始）。
 * 用于服务端状态变更后（resume / clearConversation 等）强制拉取最新 snapshot，
 * 避免 UI 滞留在旧状态。
 */
export function requestReconnect(): void {
  if (currentWs && currentWs.readyState === currentWs.OPEN) {
    currentWs.close();
    // connectWs 的 auto-reconnect 会在 onclose 后自动触发 open()
  }
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
  let backoff = 1000;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let ws: WebSocket | null = null;

  const open = () => {
    if (closed) return;
    opts.onStatus('connecting');
    ws = new WebSocket(opts.url);
    currentWs = ws;
    ws.onopen = () => { backoff = 1000; activeSend = (raw) => ws!.send(raw); opts.onStatus('open'); };
    ws.onmessage = (m) => {
      const env = parseMessage(String(m.data));
      if (env) opts.onEnvelope(env);
    };
    ws.onclose = () => {
      activeSend = null;
      currentWs = null;
      ws = null;
      opts.onStatus('closed');
      if (!closed) {
        timer = setTimeout(open, backoff);
        backoff = Math.min(backoff * 2, 10_000);
      }
    };
    ws.onerror = () => ws!.close();
  };

  // 页面从后台回到前台时，如果 WebSocket 断开则主动重连
  const onVisibilityChange = () => {
    if (document.visibilityState === 'visible' && !closed && (!ws || ws.readyState !== WebSocket.OPEN)) {
      // 清除现有的重连定时器
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      // 重置退避时间，立即重连
      backoff = 1000;
      open();
    }
  };

  // 监听页面可见性变化（移动端浏览器从后台回来时触发）
  document.addEventListener('visibilitychange', onVisibilityChange);
  open();

  return () => {
    closed = true;
    document.removeEventListener('visibilitychange', onVisibilityChange);
    if (timer) clearTimeout(timer);
    currentWs?.close();
    currentWs = null;
    ws = null;
  };
}
