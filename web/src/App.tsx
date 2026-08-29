import { createSignal, createEffect, Show } from 'solid-js';
import { state, handleEnvelope, setAutoApproveLocal, submitPrompt, removeLastUserMessage } from './stores.ts';
import { AiError } from '../../src/ai/errors.ts';
import { chat, resumeSession, putConfig, getConfig, abortAgent } from './api.ts';
import { connectWs, sendWsMessage, requestReconnect, type WsStatus } from './ws.ts';
import { parseHash, onHashChange, type Route } from './routes.ts';
import { useIsNarrow } from './use-is-narrow.ts';
import { ChatView } from './components/chat/view.tsx';
import { ChatInput } from './components/chat/input.tsx';
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
    submitPrompt(prompt);
    const result = await chat(prompt);
    if (result.status === 'error') {
      handleEnvelope({ type: 'event', ev: { type: 'error', error: new AiError('server', result.error) } });
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
      requestReconnect();
    } catch { /* user can retry */ }
  };
  const onAbort = async (name?: string) => {
    await abortAgent(name).catch(() => {});
  };

  return (
    <Show
      when={route().route === 'main'}
      fallback={(() => {
        const r = route();
        return r.route === 'agent'
          ? <AgentDetail name={r.name} />
          : <SessionList />;
      })()}
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
          <ChatView
            messages={state().messages}
            streamingContent={state().streamingMessage ? [state().streamingMessage!] : undefined}
            streamingVersion={state().streamingVersion}
            pendingPermission={state().pendingPermission}
            cwd={state().cwd}
          />
          {!isNarrow() && <SubagentPanel subagents={state().subagents} onAbort={(name) => onAbort(name)} />}
        </div>
        {isNarrow() && (
          <Drawer open={drawerOpen()} onClose={() => setDrawerOpen(false)}>
            <SubagentPanel subagents={state().subagents} onAbort={(name) => onAbort(name)} />
          </Drawer>
        )}
        <ChatInput disabled={state().running} autoApprove={state().autoApprove} onSend={onSend} onToggleAuto={onToggleAuto} onAbort={() => onAbort()} onResumeSession={onResumeSession} />
      </div>
    </Show>
  );
}
