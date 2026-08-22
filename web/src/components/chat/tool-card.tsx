import { createSignal, Show } from 'solid-js';

export function DiffBlock(props: { diff: string }) {
  return (
    <pre class="diff">
      {props.diff.split('\n').map((line) => (
        <div class={line.startsWith('+') && !line.startsWith('+++') ? 'diff-add' : line.startsWith('-') && !line.startsWith('---') ? 'diff-del' : ''}>{line || ' '}</div>
      ))}
    </pre>
  );
}

export function ToolCard(props: { tool: any; status: 'running' | 'done' | 'error' }) {
  const [open, setOpen] = createSignal(false);
  const inputPreview = () => {
    try { return JSON.stringify(props.tool.input).slice(0, 120); } catch { return String(props.tool.input); }
  };
  return (
    <div class={`tool-card ${props.status}`} onClick={() => setOpen(!open())}>
      <span class="tool-title">{props.status === 'running' ? '⏳' : props.status === 'error' ? '✗' : '✓'} {props.tool.name}</span>
      <span class="tool-input-preview">{inputPreview()}</span>
      <Show when={open()}>
        <div class="tool-body">
          <Show when={props.tool.resultContent}>
            <pre class="tool-content">{props.tool.resultContent}</pre>
          </Show>
          <Show when={props.tool.diff}>
            <DiffBlock diff={props.tool.diff} />
          </Show>
        </div>
      </Show>
    </div>
  );
}
