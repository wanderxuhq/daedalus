import { createSignal, createEffect } from 'solid-js';

/** 模块级 open 状态：按内容索引追踪，组件重建时恢复。 */
const openState = new Map<number, boolean>();

export function Thinking(props: { text: () => string; index?: number }) {
  const idx = props.index ?? 0;
  const [open, setOpen] = createSignal(openState.get(idx) ?? false);
  const [body, setBody] = createSignal('');
  createEffect(() => { setBody(props.text()); });

  const toggle = () => {
    const next = !open();
    openState.set(idx, next);
    setOpen(next);
  };

  return (
    <div class="thinking" onClick={toggle}>
      <span class="thinking-toggle">{open() ? '▼' : '▶'} thinking</span>
      {open() && <div class="thinking-body">{body()}</div>}
    </div>
  );
}
