import { createSignal, For, Show } from 'solid-js';
import { listSessions } from '../../api.ts';
import { t } from '../../i18n.ts';

interface SessionRow { id: string; title: string; updatedAt: string; messageCount: number }

export function ChatInput(props: { disabled: boolean; autoApprove: boolean; onSend: (prompt: string) => void; onToggleAuto: () => void; onAbort?: () => void; onResumeSession?: (id: string) => void }) {
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
      setSessionsError(t('input.loadFailed'));
    }
  };

  const submit = () => {
    const val = text().trim();
    if (!val || props.disabled) return;
    props.onSend(val);
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
            <span>{t('input.restoreSession')}</span>
            <button class="close-btn" onClick={() => setShowSessions(false)}>×</button>
          </div>
          <Show
            when={sessionsError()}
            fallback={
              <Show
                when={sessions().length > 0}
                fallback={<div class="sessions-empty">{t('input.noSessions')}</div>}
              >
                <ul class="sessions-popup-list">
                  <For each={sessions()}>
                    {(s) => (
                      <li class="sessions-popup-item" onClick={() => onResume(s.id)}>
                        <span class="session-title">{s.title}</span>
                        <span class="session-meta">{new Date(s.updatedAt).toLocaleString()} · {s.messageCount} {t('sessions.items')}</span>
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
        }} title={t('input.restoreSession')}>
          ↺
        </button>
        <textarea
          rows={1}
          value={text()}
          placeholder={props.disabled ? t('input.running') : t('input.placeholder')}
          onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
          }}
        />
        <Show
          when={props.disabled && props.onAbort}
          fallback={<button class="send-btn" onClick={submit} disabled={props.disabled}>⏎</button>}
        >
          <button class="abort-btn send-btn" onClick={() => props.onAbort!()} title={t('input.stop')}>⏹</button>
        </Show>
        <button class="auto-toggle" classList={{ 'auto-on': props.autoApprove }} onClick={props.onToggleAuto} title={t('input.togglePermission')}>
          {props.autoApprove ? 'auto' : 'ask'}
        </button>
      </div>
    </div>
  );
}
