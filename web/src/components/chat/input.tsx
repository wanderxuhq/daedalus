import { createSignal, For, Show } from 'solid-js';
import { listSessions } from '../../api.ts';

interface SessionRow { id: string; title: string; updatedAt: string; messageCount: number }

export function ChatInput(props: { disabled: boolean; autoApprove: boolean; onSend: (prompt: string) => void; onToggleAuto: () => void; onResumeSession?: (id: string) => void }) {
  const [text, setText] = createSignal('');
  const [showSessions, setShowSessions] = createSignal(false);
  const [sessions, setSessions] = createSignal<SessionRow[]>([]);
  const [sessionsError, setSessionsError] = createSignal<string | null>(null);

  const loadSessions = async () => {
    setSessionsError(null);
    try {
      const s = await listSessions();
      setSessions(s);
    } catch (e) {
      setSessionsError('加载会话列表失败');
    }
  };

  const submit = () => {
    const t = text().trim();
    if (!t || props.disabled) return;
    props.onSend(t);
    setText('');
  };

  const onResume = (id: string) => {
    setShowSessions(false);
    if (props.onResumeSession) {
      props.onResumeSession(id);
    }
  };

  return (
    <div class="chat-input-wrap">
      <Show when={showSessions()}>
        <div class="sessions-popup">
          <div class="sessions-popup-header">
            <span>恢复对话</span>
            <button class="close-btn" onClick={() => setShowSessions(false)}>×</button>
          </div>
          <Show
            when={sessionsError()}
            fallback={
              <Show
                when={sessions().length > 0}
                fallback={<div class="sessions-empty">暂无会话</div>}
              >
                <ul class="sessions-popup-list">
                  <For each={sessions()}>
                    {(s) => (
                      <li class="sessions-popup-item" onClick={() => onResume(s.id)}>
                        <span class="session-title">{s.title}</span>
                        <span class="session-meta">{new Date(s.updatedAt).toLocaleString()} · {s.messageCount} 条</span>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            }
          >
            <div class="sessions-error">{sessionsError()}</div>
          </Show>
        </div>
      </Show>
      <div class="chat-input">
        <button class="restore-btn" onClick={() => {
          const next = !showSessions();
          setShowSessions(next);
          if (next) loadSessions();
        }} title="恢复对话">
          ↺
        </button>
        <textarea
          rows={1}
          value={text()}
          placeholder={props.disabled ? '运行中…' : '输入消息'}
          onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
          }}
        />
        <button class="send-btn" onClick={submit} disabled={props.disabled}>⏎</button>
        <button class="auto-toggle" classList={{ 'auto-on': props.autoApprove }} onClick={props.onToggleAuto} title="权限模式切换">
          {props.autoApprove ? 'auto' : 'ask'}
        </button>
      </div>
    </div>
  );
}
