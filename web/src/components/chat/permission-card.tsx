import { Show } from 'solid-js';
import { t } from '../../i18n.ts';

export function PermissionCard(props: { pending: { id: string; action: string; target: string } | null; send: (m: { type: 'permission'; id: string; allow: boolean; always?: boolean }) => void }) {
  const p = () => props.pending;
  return (
    <Show when={p()}>
      <div class="permission-card">
        <div class="permission-title">{t('permission.allow')} {p()!.action}?</div>
        <pre class="permission-target">{p()!.target}</pre>
        <div class="permission-btns">
          <button onClick={() => props.send({ type: 'permission', id: p()!.id, allow: true })}>{t('permission.allow')}</button>
          <button onClick={() => props.send({ type: 'permission', id: p()!.id, allow: true, always: true })}>{t('permission.alwaysAllow')}</button>
          <button onClick={() => props.send({ type: 'permission', id: p()!.id, allow: false })}>{t('permission.reject')}</button>
        </div>
      </div>
    </Show>
  );
}
