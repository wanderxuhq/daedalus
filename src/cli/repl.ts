import readline from 'node:readline';
import { stdin as input, stdout as output } from 'node:process';
import { ANSI } from './render.ts';
import type { SkillInfo } from '../core/skills/types.ts';
import type { CoreEvent } from '../core/events.ts';
import type { Key } from 'node:readline';

/** readline hides `_ttyWrite` from its public types; declare the slot we patch. */
interface TtyWriteHost {
  _ttyWrite(data: string, key: Key): void;
}

/**
 * True when a keypress is Ctrl+Enter / Shift+Enter — a line continuation — as
 * opposed to a plain Enter (submit). Terminals encode the modified Enter either
 * as LF (readline reports name 'enter'), as an xterm-style `13;5~`/`13;2~`
 * escape (parsed as F3 + a modifier), or as a CSI-u escape for the Enter key
 * (`13;5u` / `13;2u`). Plain Enter always arrives as CR (name 'return'), which
 * is not matched here.
 */
export function isNewlineKey(key: Key | undefined): boolean {
  if (!key) return false;
  if (key.name === 'enter') return true; // LF from Ctrl/Shift+Enter
  if (key.name === 'f3' && (key.ctrl || key.shift)) return true; // xterm 13;5~ / 13;2~
  const seq = typeof key.sequence === 'string' ? key.sequence : '';
  // CSI-u for the Enter key (code 13) with a modifier — 13;Nu where N=2 (Shift)..8.
  // N=1 (or bare 13;u) means an unmodified Enter, which is just CR.
  return /^\x1b\[13;\d+u$/.test(seq) && !/^\x1b\[13;1?u$/.test(seq);
}

export interface EngineLike {
  subscribe(handler: (ev: CoreEvent) => void): () => void;
  run(prompt: string): Promise<string>;
  skills: SkillInfo[];
  loadSkill(name: string): Promise<SkillInfo>;
  setAskPermission(ask: (action: string, target: string) => Promise<boolean>): void;
}

export type ReplLineResult = 'exit' | 'handled' | 'unhandled';

const RESERVED = new Set(['exit', 'quit', 'help', 'skills', 'run']);

/** Handle one line of REPL input as a command. Returns how it was handled. */
export async function handleReplLine(line: string, engine: EngineLike): Promise<ReplLineResult> {
  const trimmed = line.trim();
  if (trimmed === '/exit' || trimmed === '/quit') return 'exit';
  if (trimmed === '/help') {
    console.log('Commands: /help, /exit, /skills, /<skill-name>. A prompt submits on Enter; Ctrl+Enter (or a trailing \\) continues onto the next line; /run submits the buffered multi-line prompt.');
    return 'handled';
  }
  if (trimmed === '/skills') {
    for (const s of engine.skills) {
      console.log(`${ANSI.bold}${s.name}${ANSI.reset}${s.userInvocable ? '' : ' (user-only)'}: ${s.description}`);
    }
    if (engine.skills.length === 0) console.log('No skills installed.');
    return 'handled';
  }
  if (trimmed.startsWith('/') && !trimmed.includes(' ') && !RESERVED.has(trimmed.slice(1))) {
    const name = trimmed.slice(1);
    try {
      const info = await engine.loadSkill(name);
      console.log(`${ANSI.green}Loaded skill ${info.name}:${ANSI.reset} ${info.description}`);
    } catch {
      console.error(`${ANSI.red}Unknown skill: ${name}${ANSI.reset}`);
    }
    return 'handled';
  }
  return 'unhandled';
}

export async function runRepl(engine: EngineLike): Promise<void> {
  const rl = readline.createInterface({ input, output, prompt: `${ANSI.green}›${ANSI.reset} ` });

  // Permission questions (bash/write tools) are answered on this SAME interface,
  // never on a second readline: a second interface on the same raw-mode TTY
  // double-echoes input and leaves the loop's promise unsettled ("Detected
  // unsettled top-level await"). While a question is open, keypresses build the
  // answer and are never forwarded, so readline never assembles them into a line
  // and no spurious prompt is produced.
  let newlineKeyed = false;
  let permission: { resolve: (ok: boolean) => void; buf: string } | null = null;
  const askPermission = (action: string, target: string): Promise<boolean> => {
    output.write(`${ANSI.yellow}Allow ${action}? ${target} [y/n] ${ANSI.reset}`);
    return new Promise((resolve) => { permission = { resolve, buf: '' }; });
  };
  engine.setAskPermission(askPermission);

  // Ctrl+Enter / Shift+Enter continue the input onto a new line instead of
  // submitting, like Claude Code. Terminals encode these either as LF (readline
  // reports name 'enter') or as a CSI-u escape for the Enter key — `\x1b[13;5u`
  // (Ctrl) / `\x1b[13;2u` (Shift), as sent by VSCode, Windows Terminal, kitty —
  // which readline would otherwise paste literally into the line. Plain Enter
  // always arrives as CR (name 'return') on a raw-mode terminal, so 'enter' and
  // modified CSI-u can only come from Ctrl/Shift+Enter. _ttyWrite is private but
  // stable; wrapping it lets us detect these keys and flag the line.
  const ttyWriteHost = rl as unknown as TtyWriteHost;
  const origTtyWrite = ttyWriteHost._ttyWrite.bind(rl);
  ttyWriteHost._ttyWrite = (data, key) => {
    if (permission) {
      // Answering a permission question: swallow every keypress, echo it once,
      // and resolve on Enter. Backspace edits the buffer.
      if (key?.name === 'return' || key?.name === 'enter') {
        const ok = permission.buf.trim().toLowerCase() === 'y';
        const resolve = permission.resolve;
        permission = null;
        output.write('\n');
        resolve(ok);
        return;
      }
      if (key?.name === 'backspace') {
        if (permission.buf) {
          permission.buf = permission.buf.slice(0, -1);
          output.write('\b \b');
        }
        return;
      }
      if (key?.name && key.name.length === 1) {
        permission.buf += key.name;
        output.write(key.name);
      }
      return;
    }
    if (isNewlineKey(key)) {
      newlineKeyed = true;
      // Deliver a plain Enter so the line is read normally.
      origTtyWrite(data, { ...key, name: 'return', sequence: '\r', ctrl: false, shift: false, meta: false });
      return;
    }
    origTtyWrite(data, key);
  };

  // Non-TTY input (a pipe) reaches EOF and readline auto-closes while an agent
  // turn is still in flight; prompt() on a closed interface throws
  // ERR_USE_AFTER_CLOSE, so guard every prompt.
  let closed = false;
  rl.on('close', () => { closed = true; });
  const prompt = () => { if (!closed) rl.prompt(); };

  // The final answer prints as its text_delta events stream in (renderEvent), so
  // echoing it again in dim afterwards would just duplicate it — the gray text
  // seen after a run. Echo only as a fallback for the rare adapter that puts the
  // full answer solely in the terminal 'done' with no deltas. A tool call resets
  // the flag: an answer streamed after the last tool call was rendered, but one
  // that never produced deltas still gets the echo.
  const submit = async (promptText: string) => {
    console.log(ANSI.blue + '— running —' + ANSI.reset);
    let rendered = false;
    const unsub = engine.subscribe((ev) => {
      if (ev.type === 'text_delta') rendered = true;
      else if (ev.type === 'tool_call_start') rendered = false;
    });
    try {
      const text = await engine.run(promptText);
      if (!rendered && text) console.log(ANSI.dim + text + ANSI.reset);
    } catch (e) {
      console.error(ANSI.red + `error: ${(e as Error).message}` + ANSI.reset);
    } finally {
      unsub();
    }
    console.log();
  };
  rl.prompt();
  let buffer = '';
  for await (const line of rl) {
    const continues = newlineKeyed; // Ctrl/Shift+Enter on this line?
    newlineKeyed = false;
    const result = await handleReplLine(line, engine);
    if (result === 'exit') break;
    if (result === 'handled') { prompt(); continue; }
    const trimmed = line.trim();
    if (trimmed === '/run') {
      if (buffer) { await submit(buffer); buffer = ''; }
      else console.log('Nothing to run — type a prompt first.');
      prompt();
      continue;
    }
    if (continues || trimmed.endsWith('\\')) {
      // Ctrl/Shift+Enter (or a trailing backslash) keeps building the prompt.
      const content = trimmed.endsWith('\\') ? trimmed.slice(0, -1) : trimmed;
      if (content) buffer += (buffer ? '\n' : '') + content;
      prompt();
      continue;
    }
    if (!trimmed) {
      if (buffer) { await submit(buffer); buffer = ''; }
      prompt();
      continue;
    }
    if (buffer) {
      // A normal line completes a backslash-built multi-line prompt.
      await submit(`${buffer}\n${trimmed}`);
      buffer = '';
    } else {
      // Single line: submit on the first Enter.
      await submit(trimmed);
    }
    prompt();
  }
  rl.close();
}
