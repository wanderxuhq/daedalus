import { Show, type JSX } from 'solid-js';
import { t } from '../../i18n.ts';

export function Drawer(props: { open: boolean; onClose: () => void; children: JSX.Element }) {
  return (
    <Show when={props.open}>
      <div class="drawer-backdrop" onClick={props.onClose} />
      <div class="drawer">{props.children}</div>
    </Show>
  );
}

export function AppDrawer(props: {
  open: boolean;
  onClose: () => void;
  sessionContent: JSX.Element;
  subagentContent: JSX.Element;
}) {
  return (
    <Show when={props.open}>
      <div class="drawer-backdrop" onClick={props.onClose} />
      <div class="drawer">
        <div class="drawer-section">
          <h3 class="drawer-section-header">{t('drawer.mainSession')}</h3>
          {props.sessionContent}
        </div>
        <div class="drawer-divider" />
        <div class="drawer-section">
          <h3 class="drawer-section-header">{t('drawer.subagents')}</h3>
          {props.subagentContent}
        </div>
      </div>
    </Show>
  );
}
