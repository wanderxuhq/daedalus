import { createSignal, For, Show } from 'solid-js';
import { state, handleEnvelope } from './stores.ts';
import { chat, putConfig, getConfig } from './api.ts';
import { connectWs, sendWsMessage, type WsStatus } from './ws.ts';
import { parseHash, onHashChange, type Route } from './routes.ts';
import { useIsNarrow } from './use-is-narrow.ts';
import { ChatInput } from './components/chat/input.tsx';
import { MessageBubble } from './components/chat/message.tsx';
import { PermissionCard } from './components/chat/permission-card.tsx';
import { Badge } from './components/common/badge.tsx';
import { SubagentPanel } from './components/agents/panel.tsx';
import { AgentDetail } from './components/agents/detail.tsx';
import { Drawer } from './components/common/drawer.tsx';

export function App() {
  const isNarrow = useIsNarrow();
  const [route, setRoute] = createSignal<Route>(parseHash(location.hash));
  const [drawerOpen, setDrawerOpen] = createSignal(false);
  const [wsStatus, setWsStatus] = createSignal<WsStatus>('connecting');
  onHashChange(() => { setRoute(parseHash(location.hash)); setDrawerOpen(false); });

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
    <Show
      when={route().route === 'main'}
      fallback={
        // 偏差（B）：plan 片段在三元里两次调用 route()，TS 无法据此收窄 Route 联合类型；
        // 取一次局部值以获得判别收窄，行为与 plan 意图一致。
        (() => {
          const r = route();
          return r.route === 'agent'
            ? <AgentDetail name={r.name} />
            : <div class="session-list-placeholder">sessions — Task 11</div>;
        })()
      }
    >
      <div class="app">
        <header class="topbar">
          {isNarrow() && <button class="drawer-btn" onClick={() => setDrawerOpen(true)}>☰</button>}
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
          {!isNarrow() && <SubagentPanel subagents={state().subagents} />}
        </div>
        {isNarrow() && (
          <Drawer open={drawerOpen()} onClose={() => setDrawerOpen(false)}>
            <SubagentPanel subagents={state().subagents} />
          </Drawer>
        )}
        <ChatInput disabled={state().running} autoApprove={state().autoApprove} onSend={onSend} onToggleAuto={onToggleAuto} />
      </div>
    </Show>
  );
}
