import { createSignal, createEffect } from 'solid-js';
export function Thinking(props: { text: () => string }) {
  const [open, setOpen] = createSignal(false);
  const [body, setBody] = createSignal('');
  createEffect(() => { setBody(props.text()); });
  return (
    <div class="thinking" onClick={() => setOpen(!open())}>
      <span class="thinking-toggle">{open() ? '▼' : '▶'} thinking</span>
      {open() && <div class="thinking-body">{body()}</div>}
    </div>
  );
}
