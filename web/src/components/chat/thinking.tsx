import { createSignal } from 'solid-js';
export function Thinking(props: { text: string }) {
  const [open, setOpen] = createSignal(false);
  return (
    <div class="thinking" onClick={() => setOpen(!open())}>
      <span class="thinking-toggle">{open() ? '▼' : '▶'} thinking</span>
      {open() && <div class="thinking-body">{props.text}</div>}
    </div>
  );
}
