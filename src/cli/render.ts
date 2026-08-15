import type { CoreEvent } from '../core/events.ts';

export const ANSI = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', red: '\x1b[31m',
  green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m', gray: '\x1b[90m', italic: '\x1b[3m',
} as const;

export function renderText(text: string, style: keyof typeof ANSI): string {
  return `${ANSI[style]}${text}${ANSI.reset}`;
}

export function renderEvent(ev: CoreEvent): void {
  switch (ev.type) {
    case 'text_delta': process.stdout.write(ev.text); break;
    case 'thinking_delta': process.stdout.write(`${ANSI.dim}${ANSI.italic}${ev.thinking}${ANSI.reset}`); break;
    case 'tool_call_start': process.stdout.write(`\n${renderText(`▶ ${ev.name}`, 'gray')} `); break;
    case 'tool_call_delta': process.stdout.write(ev.inputDelta); break;
    case 'skill_load': process.stdout.write(`\n${renderText(`[skill] ${ev.name} loaded`, 'green')}\n`); break;
    case 'context_trim': process.stdout.write(`\n${renderText(`— context trimmed: ${ev.kept} messages kept —`, 'dim')}\n`); break;
    case 'done': process.stdout.write('\n'); break;
    case 'error': process.stdout.write(`\n${renderText(`[error] ${ev.error.message}`, 'red')}\n`); break;
    case 'session_start': break;
    case 'session_end': break;
  }
}
