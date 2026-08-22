import { createSignal, For, onCleanup, Show } from 'solid-js';
import { state, handleEnvelope } from './stores.ts';
import { chat, putConfig, getConfig } from './api.ts';
import { connectWs, sendWsMessage, type WsStatus } from './ws.ts';
import { ChatInput } from './components/chat/input.tsx';
import { MessageBubble } from './components/chat/message.tsx';
import { DelegateRow } from './components/chat/delegate-row.tsx';
import { PermissionCard } from './components/chat/permission-card.tsx';
import { Badge } from './components/common/badge.tsx';

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
