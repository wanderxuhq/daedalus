import type { CoreEvent } from '../core/events.ts';

export const ANSI = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', red: '\x1b[31m',
  green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m', gray: '\x1b[90m',
  cyan: '\x1b[36m', magenta: '\x1b[35m', italic: '\x1b[3m',
} as const;

export function renderText(text: string, style: keyof typeof ANSI): string {
  return `${ANSI[style]}${text}${ANSI.reset}`;
}

/** Per-tool accent color, Claude-Code style (bash=shell green, read=blue, …). */
const TOOL_COLOR: Record<string, keyof typeof ANSI> = {
  bash: 'green',
  read: 'blue',
  write: 'yellow',
  edit: 'yellow',
  ls: 'cyan',
  grep: 'magenta',
  glob: 'cyan',
  Skill: 'green',
};

/** Cap how much of a tool's output is drawn to the terminal (the model still gets it all). */
const RESULT_LINE_LIMIT = 50;

function str(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  return typeof v === 'string' ? v : (v === undefined || v === null ? '' : JSON.stringify(v));
}

/**
 * A human-friendly one-line summary of a tool call's input — e.g. `$ ls -la`
 * for bash instead of `{"command":"ls -la"}`. Unknown tools fall back to the
 * raw JSON so nothing is ever hidden.
 */
export function formatToolInput(name: string, input: unknown): string {
  const o = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  switch (name) {
    case 'bash': return `$ ${str(o, 'command')}`;
    case 'read': {
      const path = str(o, 'path');
      const offset = o.offset;
      const limit = o.limit;
      if (typeof offset === 'number') {
        const start = offset + 1; // the tool's line numbers are 1-based
        const end = typeof limit === 'number' ? start + limit - 1 : undefined;
        return `${path}:${start}${end !== undefined ? `-${end}` : '…'}`;
      }
      if (typeof limit === 'number') return `${path}:1-${limit}`;
      return path;
    }
    case 'write': return str(o, 'path');
    case 'edit': return str(o, 'path');
    case 'ls': return str(o, 'path') || '.';
    case 'grep': {
      const pattern = str(o, 'pattern');
      const path = str(o, 'path') || '.';
      return pattern ? `${pattern} in ${path}` : path;
    }
    case 'glob': {
      const pattern = str(o, 'pattern');
      const path = str(o, 'path') || '.';
      return pattern ? `${pattern} in ${path}` : path;
    }
    case 'Skill': return str(o, 'name');
    default: {
      const raw = JSON.stringify(input);
      return raw ? raw.slice(0, 120) : '';
    }
  }
}

/** Box tool output with a `│` bar per line (red for errors), Claude-Code style. */
export function formatToolBody(content: string, isError: boolean): string {
  const lines = content.replace(/\n$/, '').split('\n');
  const shown = lines.slice(0, RESULT_LINE_LIMIT);
  const clipped = lines.length - shown.length;
  const bar = isError ? renderText('│', 'red') : renderText('│', 'dim');
  const paint = (l: string) => (isError ? renderText(l, 'red') : l);
  const body = shown.map((l) => `${bar} ${paint(l)}`);
  if (clipped > 0) {
    body.push(`${bar} ${renderText(`… ${clipped} more line${clipped === 1 ? '' : 's'} omitted`, 'dim')}`);
  }
  return body.join('\n');
}

/** The `⏺ bash $ cmd` header line of a tool card, colored per tool. */
function toolHeader(name: string, summary: string): string {
  return `${ANSI.bold}${ANSI[TOOL_COLOR[name] ?? 'gray']}⏺ ${name}${ANSI.reset} ${summary}`;
}

export function renderEvent(ev: CoreEvent): void {
  switch (ev.type) {
    case 'text_delta': process.stdout.write(ev.text); break;
    case 'thinking_delta': process.stdout.write(`${ANSI.dim}${ANSI.italic}${ev.thinking}${ANSI.reset}`); break;
    // The raw tool-call JSON is streamed to the model but hidden from the user.
    // Each call renders as a single self-contained card once tool_result arrives.
    case 'tool_call_start': break;
    case 'tool_call_delta': break;
    case 'tool_result': {
      const summary = formatToolInput(ev.name, ev.input);
      process.stdout.write(`\n${toolHeader(ev.name, summary)}\n`);
      process.stdout.write(`${formatToolBody(ev.content, ev.isError === true)}\n`);
      break;
    }
    case 'skill_load': process.stdout.write(`\n${renderText(`[skill] ${ev.name} loaded`, 'green')}\n`); break;
    case 'context_trim': process.stdout.write(`\n${renderText(`— context trimmed: ${ev.kept} messages kept —`, 'dim')}\n`); break;
    case 'done': process.stdout.write('\n'); break;
    case 'error': process.stdout.write(`\n${renderText(`[error] ${ev.error.message}`, 'red')}\n`); break;
    case 'session_start': break;
    case 'session_end': break;
  }
}
