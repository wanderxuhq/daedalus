import { createEffect, createSignal, For, Show } from 'solid-js';
import { listSessions, renameSession, deleteSession } from '../../api.ts';

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
    const t = draft().trim();
    if (t) { await renameSession(id, t); refresh(); }
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
        <a class="back" href="#/">← 返回</a>
        <h2>会话</h2>
        <button class="new-btn" onClick={newSession}>[+ 新建]</button>
      </header>
      <ul class="session-list">
        <For each={sessions()}>
          {(s) => (
            <li class="session-row">
              <button class="session-title" onClick={() => resume(s.id)}>{s.title}</button>
              <span class="session-meta">{new Date(s.updatedAt).toLocaleString()} · {s.messageCount} 条</span>
              <button class="session-menu" onClick={() => setMenuFor(menuFor() === s.id ? null : s.id)}>···</button>
              <Show when={menuFor() === s.id}>
                <div class="session-menu-pop">
                  <button onClick={() => { setRenaming(s.id); setDraft(s.title); setMenuFor(null); }}>重命名</button>
                  <button onClick={() => { setConfirmDelete(s.id); setMenuFor(null); }}>删除</button>
                </div>
              </Show>
              <Show when={renaming() === s.id}>
                <input value={draft()} onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void doRename(s.id); if (e.key === 'Escape') setRenaming(null); }} />
              </Show>
              <Show when={confirmDelete() === s.id}>
                <div class="confirm-delete">
                  确认删除「{s.title}」？
                  <button onClick={() => void doDelete(s.id)}>删除</button>
                  <button onClick={() => setConfirmDelete(null)}>取消</button>
                </div>
              </Show>
            </li>
          )}
        </For>
      </ul>
    </div>
  );
}
