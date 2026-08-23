import readline from 'node:readline';
import { stdin as input, stdout as output } from 'node:process';
import { ANSI } from './render.ts';
import { isCancellationError } from '../ai/errors.ts';
import type { SkillInfo } from '../core/skills/types.ts';
import type { CoreEvent } from '../core/events.ts';
import type { SessionMeta } from '../core/session-store.ts';
import type { Key } from 'node:readline';
import type { Message } from '../ai/types.ts';

/** readline hides `_ttyWrite` from its public types; declare the slot we patch. */
interface TtyWriteHost {
  _ttyWrite(data: string, key: Key): void;
}

/** Format an elapsed duration in ms as `412ms`, `1.2s` or `1m 05s`. */
export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(Math.round(s % 60)).padStart(2, '0')}s`;
}

/** Format a token count compactly: 1234 → `1.2k`, 2_300_000 → `2.3M`. */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * True when a keypress is Ctrl+Enter / Shift+Enter — a line continuation — as
 * opposed to a plain Enter (submit). Terminals encode the modified Enter either
 * as LF (readline reports name 'enter'), as an xterm-style `13;5~`/`13;2~`
 * escape (parsed as F3 + a modifier), or as a CSI-u escape for the Enter key
 * (`13;5u` / `13;2u`). Plain Enter always arrives as CR (name 'return'), which
 * is not matched here. (The TUI's raw key decoder in tui/keys.ts handles these
 * sequences itself; this helper serves the non-TUI readline path.)
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
  run(prompt: string, opts?: { signal?: AbortSignal }): Promise<string>;
  skills: SkillInfo[];
  loadSkill(name: string): Promise<SkillInfo>;
  setAskPermission(ask: (action: string, target: string) => Promise<boolean>): void;
  listSessions(): Promise<SessionMeta[]>;
  resume(id?: string): Promise<SessionMeta>;
  /** Snapshot of every live subagent (named sessions): name, message count, loaded skills. */
  listSubagents(): Array<{ name: string; messageCount: number; loadedSkills: string[] }>;
  /** Read one subagent's full message history (live in memory; never persisted). */
  getSubagentMessages(name: string): Message[];
  /** Dispose a named subagent and drop its history; the next call with that name starts fresh. */
  closeSubagent(name: string): void;
  /** Cumulative token usage across this session's runs (`/cost`). */
  usage(): { inputTokens: number; outputTokens: number };
  /** Restore the main agent's most recent file mutation (`/undo`). */
  undoLastEdit(): Promise<{ path: string; restored: boolean; message?: string } | undefined>;
  /** Session-level model override, or undefined for the client default (`/model`). */
  getModel(): string | undefined;
  /** Set the session-level model override (`/model <name>`). */
  setModel(model: string): void;
  /** Whether tool permission prompts are auto-approved (`/permissions`). */
  getAutoApprove(): boolean;
  /** Turn auto-approve on/off (`/permissions auto|ask`). */
  setAutoApprove(enabled: boolean): void;
  /** Drop conversation history but keep the system prompt (`/clear`); returns messages removed. */
  clearConversation(): number;
  /** Manually trigger context management (`/compact`). */
  compactNow(): Promise<{ status: 'compacted' | 'trimmed' | 'idle'; dropped: number; kept: number }>;
  /** Estimated token usage of the live history vs the context budget (statusline). */
  contextUsage(): { tokens: number; maxTokens: number };
  /** Create `<cwd>/DAEDALUS.md` if absent (`/init`). */
  initMemory(): Promise<{ path: string; created: boolean }>;
  /** Whether write/edit are currently removed (plan mode). */
  getPlanMode(): boolean;
  /** Enter (`true`) or leave (`false`) plan mode (`/plan`). */
  setPlanMode(enabled: boolean): void;
}

export type ReplLineResult = 'exit' | 'handled' | 'unhandled';

/**
 * Resolve whether the REPL should auto-approve tool permission prompts.
 * `--auto` forces auto-approve on; otherwise the config's `autoApprove` decides.
 */
export function resolveAutoApprove(opts: { auto?: boolean; autoApprove?: boolean }): boolean {
  return opts.auto === true || opts.autoApprove === true;
}

const RESERVED = new Set(['exit', 'quit', 'help', 'skills', 'run', 'sessions', 'resume', 'cost', 'agents', 'agent', 'undo', 'clear', 'compact', 'model', 'init', 'permissions', 'plan']);

/** Handle one line of REPL input as a command. Returns how it was handled. */
export async function handleReplLine(line: string, engine: EngineLike): Promise<ReplLineResult> {
  const trimmed = line.trim();
  if (trimmed === '/exit' || trimmed === '/quit') return 'exit';
  if (trimmed === '/help') {
    console.log('Commands: /help, /exit, /skills, /sessions, /resume [id], /agents, /agent <name>, /agent close <name>, /cost, /undo, /clear, /compact, /model [name], /init, /permissions [auto|ask], /plan, /<skill-name>. A prompt submits on Enter; Ctrl+Enter (or a trailing \\) continues onto the next line; /run submits the buffered multi-line prompt. Ctrl+C interrupts the running task (press twice to quit).');
    return 'handled';
  }
  if (trimmed === '/skills') {
    for (const s of engine.skills) {
      console.log(`${ANSI.bold}${s.name}${ANSI.reset}${s.userInvocable ? '' : ' (user-only)'}: ${s.description}`);
    }
    if (engine.skills.length === 0) console.log('No skills installed.');
    return 'handled';
  }
  if (trimmed === '/sessions') {
    const sessions = await engine.listSessions();
    if (sessions.length === 0) {
      console.log('No sessions yet — your conversations are saved after each run.');
    } else {
      for (const s of sessions) {
        console.log(`${ANSI.bold}${s.id}${ANSI.reset}  ${s.messageCount} messages  updated ${s.updatedAt}`);
      }
      console.log(`Continue one with ${ANSI.bold}/resume <id>${ANSI.reset} (no id = the latest).`);
    }
    return 'handled';
  }
  if (trimmed === '/resume' || trimmed.startsWith('/resume ')) {
    const id = trimmed === '/resume' ? undefined : trimmed.slice('/resume'.length).trim();
    try {
      const meta = await engine.resume(id);
      console.log(`${ANSI.green}resumed session ${meta.id}${ANSI.reset} (${meta.messageCount} messages)`);
    } catch (e) {
      console.error(`${ANSI.red}${(e as Error).message}${ANSI.reset}`);
    }
    return 'handled';
  }
  if (trimmed === '/cost') {
    const u = engine.usage();
    console.log(`session tokens: ${fmtTokens(u.inputTokens)} in · ${fmtTokens(u.outputTokens)} out`);
    return 'handled';
  }
  // Undo the main agent's most recent file mutation (edit/write). Snapshots are
  // taken by the tools themselves; this just pops the latest one and writes it
  // back. Subagents keep their own stacks — /undo never touches their edits.
  if (trimmed === '/undo') {
    try {
      const res = await engine.undoLastEdit();
      if (!res) {
        console.log('Nothing to undo — no edit or write by the main agent yet.');
      } else if (res.restored) {
        console.log(`${ANSI.green}undo: restored ${res.path}${ANSI.reset}`);
      } else {
        console.error(`${ANSI.red}undo failed: ${res.message}${ANSI.reset}`);
      }
    } catch (e) {
      console.error(`${ANSI.red}undo failed: ${(e as Error).message}${ANSI.reset}`);
    }
    return 'handled';
  }
  // Fresh context: drop conversation history and loaded skills, keep the system
  // prompt (cache prefix stays byte-identical, so the next run re-hits it).
  if (trimmed === '/clear') {
    const dropped = engine.clearConversation();
    if (dropped === 0) console.log('Context already clean — nothing to clear.');
    else console.log(`${ANSI.yellow}cleared ${dropped} message${dropped === 1 ? '' : 's'}${ANSI.reset} (system prompt kept)`);
    return 'handled';
  }
  // Manual context management: summarize the oldest turns with the model
  // (auto-compact), falling back to a hard trim. Idle = under budget.
  if (trimmed === '/compact') {
    try {
      const res = await engine.compactNow();
      if (res.status === 'compacted') {
        console.log(`${ANSI.green}compacted: ${res.dropped} old message${res.dropped === 1 ? '' : 's'} summarized${ANSI.reset} (${res.kept} kept)`);
      } else if (res.status === 'trimmed') {
        console.log(`${ANSI.yellow}trimmed: ${res.dropped} message${res.dropped === 1 ? '' : 's'} dropped${ANSI.reset} (${res.kept} kept)`);
      } else {
        console.log('Context under budget — nothing to compact.');
      }
    } catch (e) {
      console.error(`${ANSI.red}compact failed: ${(e as Error).message}${ANSI.reset}`);
    }
    return 'handled';
  }
  // Session-level model override; per-request, falls back to the client default.
  if (trimmed === '/model' || trimmed.startsWith('/model ')) {
    const name = trimmed === '/model' ? undefined : trimmed.slice('/model'.length).trim();
    if (!name) {
      console.log(`current model: ${engine.getModel() ?? '(client default)'} — set one with /model <name>`);
    } else {
      engine.setModel(name);
      console.log(`${ANSI.green}model set to ${name}${ANSI.reset} (this session)`);
    }
    return 'handled';
  }
  // Create the project memory file if missing; never overwrites an existing one.
  if (trimmed === '/init') {
    try {
      const res = await engine.initMemory();
      if (res.created) console.log(`${ANSI.green}created ${res.path}${ANSI.reset} — edit it with the project\'s conventions.`);
      else console.log(`${ANSI.yellow}${res.path} already exists — leaving it untouched.${ANSI.reset}`);
    } catch (e) {
      console.error(`${ANSI.red}init failed: ${(e as Error).message}${ANSI.reset}`);
    }
    return 'handled';
  }
  // Auto-approve toggle: affects only this session (the REPL's askPermission).
  if (trimmed === '/permissions' || trimmed.startsWith('/permissions ')) {
    const arg = trimmed === '/permissions' ? undefined : trimmed.slice('/permissions'.length).trim();
    if (arg === 'auto') {
      engine.setAutoApprove(true);
      console.log(`${ANSI.green}auto-approve on${ANSI.reset} — bash/write run without y/n prompts.`);
    } else if (arg === 'ask') {
      engine.setAutoApprove(false);
      console.log(`${ANSI.green}auto-approve off${ANSI.reset} — tools prompt before running.`);
    } else {
      console.log(`auto-approve: ${engine.getAutoApprove() ? 'on' : 'off'} — toggle with ${ANSI.bold}/permissions auto|ask${ANSI.reset}.`);
    }
    return 'handled';
  }
  // Plan mode: read-only exploration (write/edit removed from every toolset,
  // including subagents). One-shot: a completed run exits it automatically.
  if (trimmed === '/plan' || trimmed.startsWith('/plan ')) {
    const arg = trimmed === '/plan' ? undefined : trimmed.slice('/plan'.length).trim();
    if (arg === 'off' || arg === 'build' || arg === 'exit') {
      engine.setPlanMode(false);
      console.log(`${ANSI.green}plan mode off${ANSI.reset} — write/edit re-enabled.`);
    } else {
      engine.setPlanMode(true);
      console.log(`${ANSI.green}plan mode on${ANSI.reset} — read-only: write/edit disabled everywhere, a run exits plan mode automatically. Ask for a plan, then exit and approve it.`);
    }
    return 'handled';
  }
  // Team view: /agents lists every live subagent; /agent <name> shows one
  // subagent's history; /agent close <name> disposes it (git-branch-like lifecycle).
  if (trimmed === '/agents') {
    const subs = engine.listSubagents();
    if (subs.length === 0) {
      console.log('No subagents yet — delegate a task with an `agent` name to create one.');
    } else {
      for (const s of subs) {
        console.log(`${ANSI.bold}${s.name}${ANSI.reset}  ${s.messageCount} messages${s.loadedSkills.length ? `  skills: ${s.loadedSkills.join(', ')}` : ''}`);
      }
      console.log(`Inspect one with ${ANSI.bold}/agent <name>${ANSI.reset}, drop it with ${ANSI.bold}/agent close <name>${ANSI.reset}.`);
    }
    return 'handled';
  }
  if (trimmed === '/agent' || trimmed.startsWith('/agent ')) {
    const rest = trimmed.slice('/agent'.length).trim();
    if (!rest) {
      console.log('Usage: /agent <name>  ·  /agent close <name>');
      return 'handled';
    }
    const [action, ...nameParts] = rest.split(/\s+/);
    const name = nameParts.join(' ');
    if (action === 'close') {
      if (!name) {
        console.log('Usage: /agent close <name>');
        return 'handled';
      }
      engine.closeSubagent(name);
      console.log(`${ANSI.yellow}closed subagent ${name}${ANSI.reset}`);
      return 'handled';
    }
    const msgs = engine.getSubagentMessages(action);
    console.log(`${ANSI.bold}subagent ${action}${ANSI.reset} — ${msgs.length} messages`);
    for (const m of msgs) {
      const text = m.content.filter((c) => c.type === 'text').map((c) => (c.type === 'text' ? c.text : '')).join(' ');
      const tool = m.content.filter((c) => c.type === 'tool_call').map((c) => (c.type === 'tool_call' ? `${c.name}(${JSON.stringify(c.input).slice(0, 80)})` : '')).join(' ');
      const line = text || tool || `[${m.content.map((c) => c.type).join(',')}]`;
      console.log(`${ANSI.dim}${m.role}${ANSI.reset} ${line.slice(0, 200)}`);
    }
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

/**
 * The mode-specific view for one agent turn: the TUI pushes styled lines into
 * the scrollback (and locks the input), stream mode prints them (errors to
 * stderr). `runTurn` composes the status lines; the sink only decides where
 * they land.
 */
export interface TurnSink {
  /** Announce the submitted prompt (TUI: `› text`; stream: `— running —`). */
  echoPrompt(prompt: string): void;
  /** A status line: done / interrupted / plan-exit notice. */
  notice(line: string): void;
  /** The final answer, when no delta streamed (rare adapters). */
  echoAnswer(text: string): void;
  /** The error line (stderr in stream mode). */
  echoError(message: string): void;
  /** Lock/unlock input while a run is in flight (no-op in stream mode). */
  setRunning(running: boolean): void;
  /** Promote a half-streamed response tail (no-op in stream mode). */
  flushStream(): void;
  /** Post-turn hook (status refresh / blank line). */
  afterTurn(): void;
}

/**
 * Run one prompt through the engine and render the turn's status lines via a
 * sink. Shared by the TUI and stream REPLs so interrupt/error/usage handling
 * stays in one place. `beginRun` registers the AbortController with the mode's
 * Ctrl+C bookkeeping and returns the cleanup that clears it.
 */
export async function runTurn(
  engine: EngineLike,
  sink: TurnSink,
  promptText: string,
  beginRun: (controller: AbortController) => () => void,
): Promise<void> {
  const startedAt = Date.now();
  const wasPlan = engine.getPlanMode();
  sink.echoPrompt(promptText);
  sink.setRunning(true);
  let rendered = false;
  let runUsage = { inputTokens: 0, outputTokens: 0 };
  const controller = new AbortController();
  const endRun = beginRun(controller);
  const unsub = engine.subscribe((ev) => {
    // Subagent streaming is hidden from the view, so it must not suppress the
    // fallback echo of the main agent's final text (e.g. a delegate's report).
    if (ev.type === 'text_delta' && ev.agent === undefined) rendered = true;
    else if (ev.type === 'tool_call_start' && ev.agent === undefined) rendered = false;
    else if (ev.type === 'usage') {
      runUsage.inputTokens += ev.inputTokens;
      runUsage.outputTokens += ev.outputTokens;
    }
  });
  try {
    const text = await engine.run(promptText, { signal: controller.signal });
    if (!rendered && text) sink.echoAnswer(text);
    // A plan-mode run exits plan mode on completion (engine one-shot rule).
    if (wasPlan && !engine.getPlanMode()) {
      sink.notice(ANSI.yellow + 'plan mode exited — write/edit re-enabled. Approve the plan or refine it.' + ANSI.reset);
    }
    const usage = runUsage.inputTokens + runUsage.outputTokens > 0
      ? ANSI.dim + ` (${fmtTokens(runUsage.inputTokens)} in · ${fmtTokens(runUsage.outputTokens)} out)` + ANSI.reset
      : '';
    sink.notice(ANSI.green + `✓ done in ${formatElapsed(Date.now() - startedAt)}${usage}` + ANSI.reset);
  } catch (e) {
    if (isCancellationError(e)) {
      sink.notice(ANSI.yellow + `(interrupted after ${formatElapsed(Date.now() - startedAt)})` + ANSI.reset);
    } else {
      sink.echoError(ANSI.red + `✗ error after ${formatElapsed(Date.now() - startedAt)}: ${(e as Error).message}` + ANSI.reset);
    }
  } finally {
    // Flush any half-streamed response tail: an interrupted or errored run
    // never emits the terminal 'done' event, so the partial text would
    // otherwise sit in the pending tail and leak into the next render.
    sink.flushStream();
    endRun();
    unsub();
    sink.setRunning(false);
    sink.afterTurn();
  }
}

export async function runRepl(engine: EngineLike, opts: { autoApprove?: boolean } = {}): Promise<void> {
  // The auto-approve mode is engine state (live-toggled by `/permissions`).
  engine.setAutoApprove(resolveAutoApprove(opts));
  await runReplStream(engine);
}

/* ---------------------------------------------------------------------------
 * Stream mode: interleaved ANSI output with a
 * readline prompt. readline decodes keys and edits the line; the _ttyWrite
 * patch detects Ctrl/Shift+Enter and answers permission questions inline.
 * ------------------------------------------------------------------------- */

async function runReplStream(engine: EngineLike): Promise<void> {
  const rl = readline.createInterface({ input, output, prompt: `${ANSI.green}›${ANSI.reset} ` });

  let newlineKeyed = false;
  let buffer = '';
  // Permission prompts are QUEUED (see runReplTui for why a single slot hangs).
  interface PermissionPrompt { action: string; target: string; resolve: (ok: boolean) => void; buf: string; }
  let permissionQueue: PermissionPrompt[] = [];
  let showing: PermissionPrompt | null = null;
  const showNextPermission = () => {
    if (showing || permissionQueue.length === 0) return;
    showing = permissionQueue.shift()!;
    output.write(`${ANSI.yellow}Allow ${showing.action}? ${showing.target} [y/n] ${ANSI.reset}`);
  };
  const resolveShowing = (ok: boolean) => {
    if (!showing) return;
    const p = showing;
    showing = null;
    output.write('\n');
    p.resolve(ok);
    showNextPermission();
  };
  const askPermission = (action: string, target: string): Promise<boolean> => {
    if (engine.getAutoApprove()) return Promise.resolve(true);
    return new Promise((resolve) => {
      permissionQueue.push({ action, target, resolve, buf: '' });
      showNextPermission();
    });
  };
  engine.setAskPermission(askPermission);

  // Ctrl+Enter / Shift+Enter continue the input onto a new line instead of
  // submitting. Terminals encode these either as LF (readline reports name
  // 'enter') or as a CSI-u escape for the Enter key — `\x1b[13;5u` (Ctrl) /
  // `\x1b[13;2u` (Shift), as sent by VSCode, Windows Terminal, kitty — which
  // readline would otherwise paste literally into the line. Plain Enter always
  // arrives as CR (name 'return') on a raw-mode terminal. _ttyWrite is private
  // but stable; wrapping it lets us detect these keys and flag the line.
  const ttyWriteHost = rl as unknown as TtyWriteHost;
  const origTtyWrite = ttyWriteHost._ttyWrite.bind(rl);
  ttyWriteHost._ttyWrite = (data, key) => {
    // Answering a permission question: swallow every keypress, echo it once,
    // and resolve on Enter. Backspace edits the buffer.
    if (showing) {
      if (key?.name === 'return' || key?.name === 'enter') {
        resolveShowing(showing.buf.trim().toLowerCase() === 'y');
        return;
      }
      if (key?.ctrl && key.name === 'c') {
        // Ctrl+C during a permission question answers "no" (and never types a 'c').
        resolveShowing(false);
        return;
      }
      if (key?.name === 'backspace') {
        if (showing.buf) {
          showing.buf = showing.buf.slice(0, -1);
          output.write('\b \b');
        }
        return;
      }
      if (key?.name && key.name.length === 1) {
        showing.buf += key.name;
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

  // CC-style interrupts: Ctrl+C during a run aborts the in-flight model
  // request (and kills the running shell), a second Ctrl+C force-quits, and
  // Ctrl+C at an idle prompt exits.
  let running: { controller: AbortController; interrupted: boolean } | null = null;
  rl.on('SIGINT', () => {
    if (running) {
      if (running.interrupted) {
        process.exit(0);
      }
      running.interrupted = true;
      running.controller.abort();
      output.write('\n(interrupting…)\n');
      return;
    }
    output.write('\n');
    rl.close();
  });

  // The final answer prints as its text_delta events stream in, so echoing it
  // again afterwards would just duplicate it. Echo only as a fallback for the
  // rare adapter that delivers the answer solely via the terminal 'done'.
  const streamSink: TurnSink = {
    echoPrompt: () => console.log(ANSI.blue + '— running —' + ANSI.reset),
    notice: (line) => console.log(line),
    echoAnswer: (text) => console.log(ANSI.dim + text + ANSI.reset),
    echoError: (msg) => console.error(msg),
    setRunning: () => {},
    flushStream: () => {},
    afterTurn: () => console.log(),
  };
  const submit = (promptText: string): Promise<void> =>
    runTurn(engine, streamSink, promptText, (controller) => {
      running = { controller, interrupted: false };
      return () => { running = null; };
    });

  rl.prompt();
  try {
    for await (const line of rl) {
      const continues = newlineKeyed; // Ctrl/Shift+Enter on this line?
      newlineKeyed = false;
      const result = await handleReplLine(line, engine);
      if (result === 'exit') break;
      if (result === 'handled') {
        prompt();
        continue;
      }
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
  } finally {
    rl.close();
  }
}
