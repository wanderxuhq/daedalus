import { Show } from 'solid-js';
export function Drawer(props: { open: boolean; onClose: () => void; children: any }) {
  return (
    <Show when={props.open}>
      <div class="drawer-backdrop" onClick={props.onClose} />
      <div class="drawer">{props.children}</div>
    </Show>
  );
}
