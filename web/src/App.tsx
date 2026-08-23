import { createSignal, createEffect, For, Show } from 'solid-js';
import { state, handleEnvelope, setAutoApproveLocal, submitPrompt, removeLastUserMessage } from './stores.ts';
import { AiError } from '../../src/ai/errors.ts';
import { chat, resumeSession, putConfig, getConfig } from './api.ts';
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
import { SessionList } from './components/sessions/list.tsx';
import { t } from './i18n.ts';

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
  createEffect(() => { void getConfig().then((c) => setAutoApproveLocal(c.autoApprove)).catch(() => {}); });

  const onSend = async (prompt: string) => {
    submitPrompt(prompt); // 本地立即回显 user 消息
    const result = await chat(prompt); // 结果通过 ws 事件回流
    if (result.status === 'error') {
      // POST 失败时显示错误（ws 不会收到事件）
      handleEnvelope({ type: 'event', ev: { type: 'error', error: new AiError('server', result.error) } });
      // 如果是 409 错误（运行中），回滚用户消息
      if (result.error.includes('already in progress')) {
        removeLastUserMessage();
      }
    }
  };
  const onToggleAuto = async () => {
    const next = !state().autoApprove;
    setAutoApproveLocal(next);
    await putConfig({ autoApprove: next }).catch(() => {});
  };

  const onResumeSession = async (id: string) => {
    try {
      await resumeSession(id);
      // WebSocket 连接会自动收到 snapshot 更新
    } catch (e) {
      // 恢复失败时不做额外处理，用户可以重试
    }
  };
  const navigateToAgent = (name: string) => {
    location.hash = `#/agent/${encodeURIComponent(name)}`;
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
            : <SessionList />;
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
        <Show when={wsStatus() !== 'open'}><div class="reconnect-banner">{t('app.reconnect')}</div></Show>
        <div class="main">
          <div class="chat-stream">
            <For each={state().messages}>
              {(m) => <MessageBubble message={m} />}
            </For>
            <Show when={state().streamingMessage}>
              {(sm) => <MessageBubble message={sm()} />}
            </Show>
            <Show when={state().pendingPermission}>
              <PermissionCard pending={state().pendingPermission} send={(m) => sendWsMessage(m)} />
            </Show>
          </div>
          {!isNarrow() && <SubagentPanel subagents={state().subagents} onView={navigateToAgent} />}
        </div>
        {isNarrow() && (
          <Drawer open={drawerOpen()} onClose={() => setDrawerOpen(false)}>
            <SubagentPanel subagents={state().subagents} onView={navigateToAgent} />
          </Drawer>
        )}
        <ChatInput disabled={state().running} autoApprove={state().autoApprove} onSend={onSend} onToggleAuto={onToggleAuto} onResumeSession={onResumeSession} />
      </div>
    </Show>
  );
}
