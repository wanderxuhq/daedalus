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

  /** 回前台触发的重连中，抑制 status 信号更新，避免 banner 闪烁导致布局抖动。 */
  let suppressStatus = false;
  /** 上次收到消息的时间戳，用于500ms 僵尸检测。 */
  let lastMsgAt = Date.now();

  const open = () => {
    if (closed) return;
    if (!suppressStatus) opts.onStatus('connecting');
    ws = new WebSocket(opts.url);
    currentWs = ws;
    ws.onopen = () => {
      backoff = 1000;
      activeSend = (raw) => ws!.send(raw);
      opts.onStatus('open');
      suppressStatus = false;
    };
    ws.onmessage = (m) => {
      lastMsgAt = Date.now();
      const env = parseMessage(String(m.data));
      if (env) opts.onEnvelope(env);
    };
    ws.onclose = () => {
      activeSend = null;
      currentWs = null;
      ws = null;
      if (!suppressStatus) opts.onStatus('closed');
      if (!closed) {
        timer = setTimeout(open, backoff);
        backoff = Math.min(backoff * 2, 10_000);
      }
    };
    ws.onerror = () => ws!.close();
  };

  // 页面从后台回到前台时，确保能收到最新消息。
  // 连接断开立即重连；连接还活着时等500ms——没收到消息说明可能是僵尸连接，也重连。
  // suppressStatus 抑制重连期间的 status 信号更新，避免 banner 闪烁导致布局抖动。
  const onVisibilityChange = () => {
    if (document.visibilityState !== 'visible' || closed) return;
    if (timer) { clearTimeout(timer); timer = null; }

    const doReconnect = () => {
      suppressStatus = true;
      if (ws) { ws.close(); ws = null; activeSend = null; currentWs = null; }
      backoff = 1000;
      open();
    };

    if (!ws || ws.readyState !== WebSocket.OPEN) {
      doReconnect();
    } else {
      // 连接还活着——等500ms 看是否有新消息；没有则认为是僵尸，强制重连。
      const prev = lastMsgAt;
      setTimeout(() => {
        // 500ms 内收到了新消息，或者连接已关闭，不需要重连
        if (lastMsgAt > prev || !ws || ws.readyState !== WebSocket.OPEN) return;
        doReconnect();
      }, 500);
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
