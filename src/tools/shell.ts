import { spawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The shell process as we use it. Node's ChildProcessByStdio only models the
 * first three stdio slots, so the fd-3 command pipe is typed explicitly here.
 */
interface ShellProc {
  pid: number | undefined;
  /** Pipe handles are unref'd (see ensureProc); the intersection adds the type-level unref. */
  stdout: Readable & { unref(): void };
  stderr: Readable & { unref(): void };
  /** [stdin(ignored), stdout, stderr, fd3-command-pipe] */
  stdio: readonly [null, Readable & { unref(): void }, Readable & { unref(): void }, Writable & { unref(): void }];
  unref(): void;
  on(event: 'close', listener: (code: number | null) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  removeListener(event: 'close', listener: (code: number | null) => void): this;
}

export const BASH_TIMEOUT_MS = 120_000;

export interface ShellResult {
  /** Exit code of the command (via the sentinel; `exit N` inside the command is captured too). */
  code: number;
  /** stdout + stderr, sentinel stripped. */
  output: string;
  /** The shell's working directory after the command ran (tracks `cd`). */
  cwd: string;
}

export class ShellTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`bash: command timed out after ${timeoutMs / 1000}s — the shell was killed and will respawn`);
    this.name = 'ShellTimeoutError';
  }
}

export class ShellCancelledError extends Error {
  constructor() {
    super('bash: cancelled');
    this.name = 'ShellCancelledError';
  }
}

/**
 * A Claude Code-style persistent bash: one long-lived shell per agent, so `cd`,
 * `export`, and shell variables survive across tool calls.
 *
 * How it works (the protocol is deliberately defensive):
 *
 * 1. The shell runs a small driver script from a temp file (NOT from stdin, so
 *    bash never contends with commands for the script pipe). Its fd 3 is a
 *    dedicated command pipe; stdin is /dev/null, so `cat`/`read` in a command
 *    see EOF instantly instead of hanging or stealing the script.
 * 2. Each command is wrapped in random-nonce delimiters on fd 3. The driver
 *    accumulates the lines and `eval`s the whole command IN THE MAIN SHELL —
 *    that is what makes `cd`/`export` persist (a subshell would throw them
 *    away). `exit N` inside the command exits the shell; a `trap … EXIT`
 *    prints the sentinel in that case.
 * 3. After each command the driver prints a sentinel line carrying rc + PWD.
 *    The Node side waits for its nonce, then parses both.
 * 4. Timeouts and Ctrl+C kill the whole process group (spawned `detached`, so
 *    the shell is its own group leader) — no orphaned subshells or background
 *    jobs. The next call respawns at the last tracked cwd.
 *
 * Known limits (documented, not hidden):
 * - `exec SOMETHING` replaces the shell, so no sentinel arrives — it hangs
 *   until the timeout kills the group.
 * - Output from backgrounded processes (`sleep 100 &`) can leak into a LATER
 *   command's result; there is no way to separate it without a pty.
 * - Interactive programs (vim, htop) have no TTY and will fail or degrade.
 */
export class PersistentShell {
  private proc: ShellProc | null = null;
  private loopFile: string | null = null;
  private cwd: string;
  /** Serializes commands: parallel tool calls for the same agent queue here. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(initialCwd: string) {
    this.cwd = initialCwd;
  }

  run(command: string, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<ShellResult> {
    const task = this.queue.then(() => this.exec(command, opts));
    // Keep the chain alive even when a command rejects (timeout, kill).
    this.queue = task.then(() => undefined, () => undefined);
    return task;
  }

  get currentCwd(): string {
    return this.cwd;
  }

  /** Kill the shell and forget it. Idempotent; the next run() respawns. */
  kill(): void {
    this.destroy('SIGKILL');
  }

  private destroy(sig: NodeJS.Signals): void {
    const p = this.proc;
    this.proc = null;
    if (p?.pid) {
      try {
        process.kill(-p.pid, sig); // process group: detached ⇒ the shell is the leader
      } catch {
        // already gone
      }
    }
    if (this.loopFile) {
      // rmSync: destroy can run inside the process 'exit' hook where async
      // cleanup never completes.
      rmSync(this.loopFile, { force: true });
      this.loopFile = null;
    }
  }

  private async ensureProc(): Promise<ShellProc> {
    if (this.proc) return this.proc;
    const dir = join(tmpdir(), 'daedalus');
    await mkdir(dir, { recursive: true });
    const loopFile = join(dir, `shell-loop-${process.pid}-${randomBytes(4).toString('hex')}.sh`);
    await writeFile(loopFile, DRIVER_SCRIPT, 'utf8');
    const proc = spawn('bash', ['--noprofile', '--norc', loopFile], {
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'] as const,
      detached: true, // own process group so timeouts can kill the whole tree
      // Respawn lands on the last tracked cwd, not the host process's cwd.
      cwd: this.cwd,
    }) as unknown as ShellProc;
    // An idle shell must not keep the host process alive; the exit hook below
    // kills leftover groups when the process goes away. unref() on the ChildProcess
    // alone is NOT enough: the stdio pipe handles (stdout/stderr/fd3) stay ref'd
    // and keep the event loop alive forever — a CLI that ran bash could never
    // exit naturally. Unref all three pipes so the loop drains once no work is
    // pending; the live shell still delivers its data (unref only drops the
    // keep-alive, not the events).
    proc.unref();
    proc.stdout.unref();
    proc.stderr.unref();
    proc.stdio[3].unref();
    proc.on('close', () => {
      if (this.proc === proc) this.proc = null;
    });
    proc.on('error', () => {
      if (this.proc === proc) this.proc = null;
    });
    // Permanent swallow for the command pipe's 'error'. It can fire
    // asynchronously AFTER an exec-level handler was removed — when a write
    // fails, the write callback gets the EPIPE first, then the socket re-emits
    // 'error' on the next tick, by which time the exec-level retry has already
    // cleaned its listener up. Without this permanent listener that late event
    // would surface as an unhandled 'error' and crash the whole host process.
    proc.stdio[3].on('error', () => { /* exec-level handler does the respawn work */ });
    this.proc = proc;
    this.loopFile = loopFile;
    return proc;
  }

  private async exec(command: string, opts: { signal?: AbortSignal; timeoutMs?: number }, retried = false): Promise<ShellResult> {    const proc = await this.ensureProc();
    const timeoutMs = opts.timeoutMs ?? BASH_TIMEOUT_MS;
    const nonce = randomBytes(6).toString('hex');
    const sentinel = `__DAEDALUS_SENTINEL__${nonce}`;
    const script = `__DAEDALUS_START__${nonce}\n${command}\n__DAEDALUS_END__${nonce}\n`;

    let stdoutBuffers: Buffer[] = [];
    let stderrBuffers: Buffer[] = [];
    let stdoutLen = 0;
    let stderrLen = 0;
    let settled = false;

    return new Promise<ShellResult>((resolve, reject) => {
      const resolveFromBuffer = () => {
        // Search for sentinel across all buffered data
        const fullStdout = Buffer.concat(stdoutBuffers).toString();
        const idx = fullStdout.indexOf(sentinel);
        if (idx === -1) return false;
        const lineEnd = fullStdout.indexOf('\n', idx);
        const line = fullStdout.slice(idx, lineEnd === -1 ? undefined : lineEnd).trim();
        const m = line.match(/rc=(-?\d+) pwd=(.*)$/);
        if (!m) {
          finish(() => reject(new Error('bash: failed to parse the command sentinel')));
          return true;
        }
        const code = Number(m[1]);
        const pwd = m[2];
        // Everything before the sentinel line is the command's stdout.
        const out = fullStdout.slice(0, idx).replace(/\s+$/, '');
        const fullStderr = Buffer.concat(stderrBuffers).toString();
        this.cwd = pwd;
        finish(() => resolve({ code, output: [out, fullStderr].filter(Boolean).join('\n'), cwd: pwd }));
        return true;
      };
      const cleanup = () => {
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        proc.stdout.removeListener('data', onData);
        proc.stderr.removeListener('data', onErr);
        proc.removeListener('close', onExit);
        proc.stdio[3].removeListener('error', onPipeError);
      };
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };
      // A failed write to the command pipe means the shell is already dead —
      // most often the PREVIOUS command was `exit N` (the sentinel resolves
      // this command, but the proc is only dropped on 'close', which races
      // after it). Drop the corpse and retry exactly once against a fresh
      // shell. Shared by the write callback AND the pipe 'error' event: EPIPE
      // can surface as either, so both funnel here (settled dedupes).
      const handleWriteFailure = (err: Error) => {
        if (settled) return;
        if (retried) {
          finish(() => reject(new Error(`bash: failed to write command: ${err.message}`)));
          return;
        }
        settled = true;
        cleanup();
        this.destroy('SIGKILL'); // clears this.proc; the respawn lands on the tracked cwd
        void this.exec(command, opts, true).then(resolve, reject);
      };
      const onPipeError = (e: Error) => handleWriteFailure(e);
      const onData = (d: Buffer) => {
        stdoutBuffers.push(d);
        stdoutLen += d.length;
        resolveFromBuffer();
      };
      const onErr = (d: Buffer) => {
        stderrBuffers.push(d);
        stderrLen += d.length;
      };
      const onExit = (code: number | null) => {
        // The shell died mid-command. Normally the sentinel arrived first; if
        // 'close' wins the race (a `exit N` command), parse the buffer as a
        // fallback before rejecting — the EXIT trap's sentinel may still be
        // in flight.
        if (resolveFromBuffer()) return;
        finish(() => reject(new Error(`bash: shell exited unexpectedly (code ${code})`)));
      };
      const onAbort = () => {
        finish(() => {
          this.destroy('SIGKILL');
          reject(new ShellCancelledError());
        });
      };
      const onTimeout = () => {
        finish(() => {
          this.destroy('SIGKILL');
          reject(new ShellTimeoutError(timeoutMs));
        });
      };
      const timer = setTimeout(onTimeout, timeoutMs);
      if (opts.signal) {
        if (opts.signal.aborted) {
          onAbort();
          return;
        }
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }
      proc.stdout.on('data', onData);
      proc.stderr.on('data', onErr);
      proc.on('close', onExit);
      // Without this listener an EPIPE on the command pipe would surface as an
      // unhandled 'error' event and crash the whole host process.
      proc.stdio[3].on('error', onPipeError);
      proc.stdio[3].write(script, (err) => {
        if (err) handleWriteFailure(err);
      });
    });
  }
}

/**
 * Driver run inside every shell. Reads commands off fd 3 (the dedicated pipe),
 * evals them in the main shell (so `cd`/`export` persist), and prints a
 * sentinel with rc + PWD after each. The EXIT trap covers `exit N` commands,
 * which would otherwise end the shell before the loop could print.
 *
 * Bash-only by design (we always spawn `bash`); written to tmpdir per shell.
 */
const DRIVER_SCRIPT = `\
exec 0< /dev/null
NONCE=''
# Capture $? FIRST — every command in the trap (the [ -n ] test, printf) would
# otherwise overwrite it, so \`exit N\` would always report rc=0. Save into a
# variable before any other statement runs.
trap 'RC=$?; if [ -n "$NONCE" ]; then printf "__DAEDALUS_SENTINEL__%s rc=%s pwd=%s\\n" "$NONCE" "$RC" "$PWD"; fi' EXIT
# read from fd 3 explicitly — a loop-level "done <&3" redirect would ALSO hand
# fd 3 to every command inside the loop (cat/read would steal the command pipe).
while IFS= read -r line <&3; do
  case "$line" in
    __DAEDALUS_START__*)
      NONCE="\${line#__DAEDALUS_START__}"
      CMD=''
      ;;
    __DAEDALUS_END__*)
      eval "$CMD"
      rc=$?
      printf '__DAEDALUS_SENTINEL__%s rc=%s pwd=%s\\n' "$NONCE" "$rc" "$PWD"
      ;;
    *)
      CMD="$CMD$line
"
      ;;
  esac
done
`;

/**
 * Per-agent shell registry: the main agent and each named subagent get their
 * own PersistentShell, so a subagent's `cd` never leaks into the main agent's
 * shell (and vice versa). One registry lives on the engine and is cleared on
 * dispose; an exit hook kills leftover shells if the process dies first.
 */
export class ShellRegistry {
  private shells = new Map<string, PersistentShell>();
  private readonly defaultCwd: string;

  constructor(defaultCwd: string) {
    this.defaultCwd = defaultCwd;
    process.once('exit', () => this.clear());
  }

  /** The shell for an agent; falls back to the main shell when no agent is named. */
  get(agent?: string): PersistentShell {
    const key = agent ?? 'main';
    let shell = this.shells.get(key);
    if (!shell) {
      shell = new PersistentShell(this.defaultCwd);
      this.shells.set(key, shell);
    }
    return shell;
  }

  /** Kill an agent's shell; the next call respawns it at the default cwd. */
  reset(agent?: string): void {
    const key = agent ?? 'main';
    const shell = this.shells.get(key);
    if (shell) {
      shell.kill();
      this.shells.delete(key);
    }
  }

  clear(): void {
    for (const shell of this.shells.values()) shell.kill();
    this.shells.clear();
  }

  get size(): number {
    return this.shells.size;
  }
}
