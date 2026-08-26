import { createSignal, Show } from 'solid-js';
import type { ToolInfo } from '../../types/messages.ts';

export function DiffBlock(props: { diff: string }) {
  return (
    <pre class="diff">
      {props.diff.split('\n').map((line) => (
        <div class={line.startsWith('+') && !line.startsWith('+++') ? 'diff-add' : line.startsWith('-') && !line.startsWith('---') ? 'diff-del' : ''}>{line || ' '}</div>
      ))}
    </pre>
  );
}

/** Format a path: relative to cwd if under cwd, absolute otherwise. */
function fmtPath(p: string, cwd?: string): string {
  if (!cwd || !p) return p;
  const norm = (s: string) => s.replace(/\\/g, '/');
  const nc = norm(cwd);
  const np = norm(p);
  if (np.startsWith(nc)) {
    const rel = np.slice(nc.length).replace(/^\//, '');
    return rel || '.';
  }
  return p;
}

/** Truncate with ellipsis */
function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/** Build a human-readable preview for the tool input. */
function formatPreview(name: string, input: unknown, cwd?: string): string {
  if (!input || typeof input !== 'object') return '';
  const inp = input as Record<string, unknown>;
  switch (name) {
    case 'read': {
      const p = fmtPath(String(inp.path ?? ''), cwd);
      const parts = [p];
      if (typeof inp.offset === 'number') parts.push(`L${inp.offset}`);
      if (typeof inp.limit === 'number') parts.push(`${inp.limit} lines`);
      return parts.join('  ');
    }
    case 'write':
      return fmtPath(String(inp.path ?? ''), cwd);
    case 'edit': {
      const p = fmtPath(String(inp.path ?? ''), cwd);
      // Show a short snippet of what's being replaced
      const old = typeof inp.oldString === 'string' ? truncate(inp.oldString.trim(), 40) : '';
      return old ? `${p}  "${old}…"` : p;
    }
    case 'bash':
      return truncate(String(inp.command ?? ''), 80);
    case 'ls':
      return fmtPath(String(inp.path ?? '.'), cwd);
    case 'glob': {
      const p = String(inp.pattern ?? '');
      const dir = inp.path ? fmtPath(String(inp.path), cwd) : '';
      return dir ? `${dir}  ${p}` : p;
    }
    case 'grep': {
      const p = String(inp.pattern ?? '');
      const dir = inp.path ? fmtPath(String(inp.path), cwd) : '';
      return dir ? `${dir}  ${p}` : p;
    }
    case 'Skill':
      return String(inp.name ?? '');
    case 'delegate': {
      const task = truncate(String(inp.task ?? ''), 60);
      const agent = inp.agent ? ` [${inp.agent}]` : '';
      return `${task}${agent}`;
    }
    case 'delegateMany': {
      const tasks = inp.tasks;
      if (Array.isArray(tasks)) {
        return `${tasks.length} tasks: ` + tasks.map((t: Record<string, unknown>) => truncate(String(t.task ?? ''), 30)).join(' | ');
      }
      return '';
    }
    case 'consult':
      return `@${inp.agent ?? '?'}  ${truncate(String(inp.question ?? ''), 50)}`;
    default:
      try { return JSON.stringify(inp).slice(0, 120); } catch { return String(inp); }
  }
}

export function ToolCard(props: { tool: ToolInfo; status: 'running' | 'done' | 'error'; cwd?: string }) {
  const [open, setOpen] = createSignal(false);
  const preview = () => formatPreview(props.tool.name, props.tool.input, props.cwd);
  return (
    <div class={`tool-card ${props.status}`} onClick={() => setOpen(!open())}>
      <span class="tool-title">{props.status === 'running' ? '⏳' : props.status === 'error' ? '✗' : '✓'} {props.tool.name}</span>
      <span class="tool-input-preview">{preview()}</span>
      <Show when={open()}>
        <div class="tool-body">
          <Show when={props.tool.diff}>
            <DiffBlock diff={props.tool.diff!} />
          </Show>
          <Show when={!props.tool.diff && props.tool.content}>
            <pre class="tool-content">{props.tool.content}</pre>
          </Show>
        </div>
      </Show>
    </div>
  );
}
