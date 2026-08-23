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
  delegate: 'magenta',
  delegateMany: 'magenta',
};

/**
 * Cap how much of a tool's output is drawn to the terminal (the model still gets it all).
 */
const RESULT_LINE_LIMIT = 50;
const DIFF_LINE_LIMIT = 60;

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

/**
 * One self-contained tool card: the colored `⏺ name summary` header line plus
 * the body — a unified diff when the tool returned one, otherwise the boxed
 * output. Shared by the stream renderer and the TUI so both draw identical cards.
 */
export function formatToolCard(name: string, input: unknown, content: string, opts: { isError?: boolean; diff?: string } = {}): string {
  const header = toolHeader(name, formatToolInput(name, input));
  const body = opts.diff !== undefined ? formatDiff(opts.diff) : formatToolBody(content, opts.isError === true);
  return `${header}\n${body}`;
}

/** The `⏺ bash $ cmd` header line of a tool card, colored per tool. */
function toolHeader(name: string, summary: string): string {
  return `${ANSI.bold}${ANSI[TOOL_COLOR[name] ?? 'gray']}⏺ ${name}${ANSI.reset} ${summary}`;
}

/**
 * Draw an edit/write diff card: green additions, red removals, cyan hunk
 * headers, dim context. Capped at {@link DIFF_LINE_LIMIT} lines — a huge
 * write's diff must not flood the terminal (the model still gets the full
 * content through its own result block).
 */
export function formatDiff(diff: string): string {
  const lines = diff.split('\n');
  const shown = lines.slice(0, DIFF_LINE_LIMIT);
  const clipped = lines.length - shown.length;
  const bar = renderText('│', 'dim');
  const paint = (l: string): string => {
    if (l.startsWith('+')) return `${bar} ${renderText(l, 'green')}`;
    if (l.startsWith('-')) return `${bar} ${renderText(l, 'red')}`;
    if (l.startsWith('@@')) return `${bar} ${renderText(l, 'cyan')}`;
    return `${bar} ${renderText(l, 'dim')}`;
  };
  const body = shown.map(paint);
  if (clipped > 0) {
    body.push(`${bar} ${renderText(`… ${clipped} more diff line${clipped === 1 ? '' : 's'} omitted`, 'dim')}`);
  }
  return body.join('\n');
}

/** Prefix an event line with a subagent tag when the event carries one. */
function agentTag(agent?: string): string {
  return agent ? `${ANSI.cyan}⏺ ${agent}${ANSI.reset} ` : '';
}

// Streaming text/thinking carries no per-chunk tag; remember whose stream is
// active so a switch between agents (or back to the main agent) draws a tag at
// the boundary instead of on every chunk. Tool cards reset it: the next stream
// after a card belongs to whoever the card's tag said.
let streamAgent: string | undefined;

// Thinking deltas arrive word-by-word; wrapping each chunk in dim+italic on its
// own would interleave escape codes with every word. Buffer the whole thinking
// segment and wrap it ONCE when it ends (first text delta, tool card, or 'done').
let thinkingBuf = '';

/** Close the open thinking segment, styled once (dim italic), if any. */
function flushThinking(): void {
  if (!thinkingBuf) return;
  process.stdout.write(`${ANSI.dim}${ANSI.italic}${thinkingBuf}${ANSI.reset}`);
  thinkingBuf = '';
}

/** Tag a new streaming segment when the emitting agent changes. */
function beginStream(agent?: string): void {
  if (agent === streamAgent) return;
  flushThinking(); // a different agent owns the next segment
  if (streamAgent !== undefined) process.stdout.write('\n');
  if (agent) process.stdout.write(`\n${agentTag(agent)}`);
  streamAgent = agent;
}

/**
 * A stdout renderer for single-shot (`-p`) mode: streams ONLY the model's final
 * answer text — no thinking, no tool cards, no notices — so script/CI output is
 * the answer alone. `hasOutput()` tells the caller whether any text actually
 * streamed, so a rare adapter that delivers the answer only via the terminal
 * 'done' can fall back to printing the result verbatim (no double print).
 */
export function streamAnswerOnly(): { handler: (ev: CoreEvent) => void; hasOutput: () => boolean } {
  let streamed = false;
  return {
    handler(ev: CoreEvent) {
      if (ev.type === 'text_delta') {
        process.stdout.write(ev.text);
        streamed = true;
      }
    },
    hasOutput: () => streamed,
  };
}

export function renderEvent(ev: CoreEvent): void {
  // Subagent internals (streamed text/thinking, tool cards, skill loads,
  // context notes) are forwarded onto the main bus with an agent tag so /cost
  // and the UI wiring still see them — but drawing them floods the console.
  // The main agent's own events carry no agent, `delegate_start` (the task
  // card) and `error` are still shown, and a subagent's final report surfaces
  // as the main session's untagged tool_result — so hiding these loses no
  // signal the user needs. To bring them back, remove the early return below.
  if (
    ev.agent !== undefined &&
    (ev.type === 'text_delta' || ev.type === 'thinking_delta' ||
     ev.type === 'tool_call_start' || ev.type === 'tool_call_delta' ||
     ev.type === 'tool_result' || ev.type === 'skill_load' ||
     ev.type === 'context_compact' || ev.type === 'context_trim')
  ) {
    return;
  }
  switch (ev.type) {
    case 'text_delta': {
      // The thinking segment ended; the answer starts here. Give the thinking
      // its own line (like the TUI's segment switch) unless it already ended
      // with one.
      const hadThinking = thinkingBuf.length > 0;
      const endedWithNl = thinkingBuf.endsWith('\n');
      flushThinking();
      if (hadThinking && !endedWithNl) process.stdout.write('\n');
      beginStream(ev.agent);
      process.stdout.write(ev.text);
      break;
    }
    case 'thinking_delta': {
      beginStream(ev.agent);
      thinkingBuf += ev.thinking;
      break;
    }
    // The raw tool-call JSON is streamed to the model but hidden from the user.
    // Each call renders as a single self-contained card once tool_result arrives.
    case 'tool_call_start': flushThinking(); streamAgent = undefined; break;
    case 'tool_call_delta': break;
    case 'tool_result': {
      flushThinking();
      const card = formatToolCard(ev.name, ev.input, ev.content, { isError: ev.isError === true, diff: ev.diff });
      process.stdout.write(`\n${agentTag(ev.agent)}${card}\n`);
      break;
    }
    case 'skill_load': flushThinking(); process.stdout.write(`\n${agentTag(ev.agent)}${renderText(`[skill] ${ev.name} loaded`, 'green')}\n`); break;
    case 'delegate_start': {
      flushThinking();
      const task = ev.task ? `: ${ev.task.length > 80 ? `${ev.task.slice(0, 80)}…` : ev.task}` : '';
      process.stdout.write(`\n${renderText(`→ subagent${ev.agent ? ` [${ev.agent}]` : ''}${task}`, 'cyan')}\n`);
      break;
    }
    case 'context_compact': flushThinking(); process.stdout.write(`\n${agentTag(ev.agent)}${renderText(`— context compacted: ${ev.dropped} messages summarized —`, 'dim')}\n`); break;
    case 'context_trim': flushThinking(); process.stdout.write(`\n${agentTag(ev.agent)}${renderText(`— context trimmed: ${ev.kept} messages kept —`, 'dim')}\n`); break;
    case 'done': flushThinking(); process.stdout.write('\n'); break;
    case 'error': flushThinking(); process.stdout.write(`\n${agentTag(ev.agent)}${renderText(`[error] ${ev.error.message}`, 'red')}\n`); break;
    case 'session_start': break;
    case 'session_end': break;
  }
}
