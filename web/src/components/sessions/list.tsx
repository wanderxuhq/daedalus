import { createEffect, createSignal, For, Show } from 'solid-js';
import { listSessions, renameSession, deleteSession } from '../../api.ts';
import { t } from '../../i18n.ts';

interface SessionRow { id: string; title: string; updatedAt: string; messageCount: number }

export function SessionList() {
  const [sessions, setSessions] = createSignal<SessionRow[]>([]);
  const [menuFor, setMenuFor] = createSignal<string | null>(null);
  const [confirmDelete, setConfirmDelete] = createSignal<string | null>(null);
  const [renaming, setRenaming] = createSignal<string | null>(null);
  const [draft, setDraft] = createSignal('');

  const refresh = () => void listSessions().then(setSessions).catch(() => {});
  createEffect(refresh);

  const resume = (id: string) => {
    void fetch('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) }).then(() => { location.hash = '#/'; });
  };
  const newSession = () => {
    void fetch('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(() => { location.hash = '#/'; });
  };
  const doRename = async (id: string) => {
    const val = draft().trim();
    if (val) { await renameSession(id, val); refresh(); }
    setRenaming(null);
  };
  const doDelete = async (id: string) => {
    await deleteSession(id);
    setConfirmDelete(null);
    refresh();
  };

  return (
    <div class="sessions">
      <header class="sessions-topbar">
        <a class="back" href="#/">{t('sessions.back')}</a>
        <h2>{t('sessions.title')}</h2>
        <button class="new-btn" onClick={newSession}>{t('sessions.new')}</button>
      </header>
      <ul class="session-list">
        <For each={sessions()}>
          {(s) => (
            <li class="session-row">
              <button class="session-title" onClick={() => resume(s.id)}>{s.title}</button>
              <span class="session-meta">{new Date(s.updatedAt).toLocaleString()} · {s.messageCount} {t('sessions.items')}</span>
              <button class="session-menu" onClick={() => setMenuFor(menuFor() === s.id ? null : s.id)}>···</button>
              <Show when={menuFor() === s.id}>
                <div class="session-menu-pop">
                  <button onClick={() => { setRenaming(s.id); setDraft(s.title); setMenuFor(null); }}>{t('sessions.rename')}</button>
                  <button onClick={() => { setConfirmDelete(s.id); setMenuFor(null); }}>{t('sessions.delete')}</button>
                </div>
              </Show>
              <Show when={renaming() === s.id}>
                <input value={draft()} onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void doRename(s.id); if (e.key === 'Escape') setRenaming(null); }} />
              </Show>
              <Show when={confirmDelete() === s.id}>
                <div class="confirm-delete">
                  {t('sessions.confirmDelete', { title: s.title })}
                  <button onClick={() => void doDelete(s.id)}>{t('sessions.delete')}</button>
                  <button onClick={() => setConfirmDelete(null)}>{t('sessions.cancel')}</button>
                </div>
              </Show>
            </li>
          )}
        </For>
      </ul>
    </div>
  );
}
