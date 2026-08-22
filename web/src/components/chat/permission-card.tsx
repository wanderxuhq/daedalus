import { Show } from 'solid-js';
export function PermissionCard(props: { pending: { id: string; action: string; target: string } | null; send: (m: { type: 'permission'; id: string; allow: boolean; always?: boolean }) => void }) {
  const p = () => props.pending;
  return (
    <Show when={p()}>
      <div class="permission-card">
        <div class="permission-title">允许 {p()!.action}?</div>
        <pre class="permission-target">{p()!.target}</pre>
        <div class="permission-btns">
          <button onClick={() => props.send({ type: 'permission', id: p()!.id, allow: true })}>允许</button>
          <button onClick={() => props.send({ type: 'permission', id: p()!.id, allow: true, always: true })}>本轮始终允许</button>
          <button onClick={() => props.send({ type: 'permission', id: p()!.id, allow: false })}>拒绝</button>
        </div>
      </div>
    </Show>
  );
}
