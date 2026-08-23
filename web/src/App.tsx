import { createSignal, createEffect, For, Show } from 'solid-js';
import { state, handleEnvelope, setAutoApproveLocal, submitPrompt, submitSubagentPrompt, clearError, setViewingSubagent, setSubagentMessages } from './stores.ts';
import { chat, chatAgent, getSubagentMessages, putConfig, getConfig } from './api.ts';
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

/** 快照回填的存量消息里混着 role:'system'（引擎把 system prompt 存进会话）——
 *  它是给模型的指令，不该作为聊天气泡渲染。CLI 渲染实时事件所以从不见到它；
 *  服务端快照也已剔除，这里是前端兜底。 */
function visibleMessages(s: { messages: unknown[] }): unknown[] {
  return s.messages.filter((m) => (m as { role?: string }).role !== 'system');
}

export function App() {
  const isNarrow = useIsNarrow();
  const [route, setRoute] = createSignal<Route>(parseHash(location.hash));
  const [drawerOpen, setDrawerOpen] = createSignal(false);
  const [wsStatus, setWsStatus] = createSignal<WsStatus>('connecting');
  const [submitError, setSubmitError] = createSignal<string | null>(null);
  onHashChange(() => { setRoute(parseHash(location.hash)); setDrawerOpen(false); });

  // ws 连接一次（应用生命周期）：事件 → store
  connectWs({
    url: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws`,
    onEnvelope: handleEnvelope,
    onStatus: setWsStatus,
  });
  createEffect(() => { void getConfig().then((c) => setAutoApproveLocal(c.autoApprove)).catch(() => {}); });

  // 切换到子代理时，从 API 加载其历史消息。
  createEffect(() => {
    const name = state().viewingSubagent;
    if (!name) return;
    void getSubagentMessages(name).then((ms) => setSubagentMessages(ms)).catch(() => {});
  });

  const onSend = async (prompt: string) => {
    const agent = state().viewingSubagent;
    if (agent) {
      submitSubagentPrompt(prompt);
      const res = await chatAgent(agent, prompt);
      if (res.status === 'error') setSubmitError(res.error);
    } else {
      submitPrompt(prompt);
      const res = await chat(prompt);
      if (res.status === 'error') setSubmitError(res.error);
    }
  };

  const onToggleAuto = async () => {
    const next = !state().autoApprove;
    setAutoApproveLocal(next);
    await putConfig({ autoApprove: next }).catch(() => {});
  };

  const onResumeSession = async (id: string) => {
    try {
      await fetch('/api/sessions', { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify({ id }) 
      });
      // WebSocket 连接会自动收到 snapshot 更新
    } catch (e) {
      setSubmitError((e as Error).message);
    }
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
        <Show when={wsStatus() !== 'open'}><div class="reconnect-banner">连接断开，重连中…</div></Show>
        <Show when={state().error || submitError()}>
          {(err) => (
            <div class="error-banner" onClick={() => { setSubmitError(null); clearError(); }}>{err()}</div>
          )}
        </Show>
        <div class="main">
          <div class="chat-stream">
            <Show when={state().viewingSubagent}>
              <div class="agent-viewing-header">
                <button class="back" onClick={() => setViewingSubagent(null)}>← 返回</button>
                <span class="agent-viewing-name">{state().viewingSubagent}</span>
                <Badge status={state().subagents.find((a) => a.name === state().viewingSubagent)?.status ?? 'running'} />
              </div>
            </Show>
            <For each={state().viewingSubagent ? state().subagentMessages : [...visibleMessages(state()), ...(state().streamingMessage ? [state().streamingMessage] : [])]}>
              {(m) => <MessageBubble message={m} />}
            </For>
            <Show when={state().pendingPermission}>
              <PermissionCard pending={state().pendingPermission} send={(m) => sendWsMessage(m)} />
            </Show>
          </div>
          {!isNarrow() && (
            <div class="sidebar-wrap">
              <SubagentPanel subagents={state().subagents} viewingSubagent={state().viewingSubagent} onView={(name) => { setViewingSubagent(name); setDrawerOpen(false); }} onReturnToMain={() => setViewingSubagent(null)} />
            </div>
          )}
        </div>
        {isNarrow() && (
          <Drawer open={drawerOpen()} onClose={() => setDrawerOpen(false)}>
            <SubagentPanel subagents={state().subagents} viewingSubagent={state().viewingSubagent} onView={(name) => { setViewingSubagent(name); setDrawerOpen(false); }} onReturnToMain={() => setViewingSubagent(null)} />
          </Drawer>
        )}
        <ChatInput disabled={state().running} autoApprove={state().autoApprove} onSend={onSend} onToggleAuto={onToggleAuto} agentName={state().viewingSubagent} onResumeSession={onResumeSession} />
      </div>
    </Show>
  );
}
