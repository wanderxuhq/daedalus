import { spawn } from 'node:child_process';

/**
 * Claude Code-style lifecycle hooks: shell commands run at agent/tool
 * milestones, fed a JSON payload on stdin. Intended for project automation
 * (lint-on-edit, permission guards, notifications) without touching daedalus
 * internals.
 *
 * Failure semantics: a hook that cannot spawn, times out, or exits non-zero is
 * logged nowhere and NEVER breaks the agent — hooks are advisory. The one
 * exception is a PreToolUse hook that explicitly denies the call.
 */
export interface HookRule {
  /** Regex matched against `${toolName}\n${JSON.stringify(toolInput)}`. */
  matcher: string;
  /** Shell command to run (spawned with `shell: true`). */
  command: string;
  /** Kill the hook after this many ms (default {@link DEFAULT_HOOK_TIMEOUT_MS}). */
  timeoutMs?: number;
}

export interface HookConfig {
  /** Run before matching tool calls; may deny or append context (JSON stdout). */
  preToolUse?: HookRule[];
  /** Run after matching tool calls complete; never modifies the result. */
  postToolUse?: HookRule[];
  /** Run once when the session ends (engine dispose). */
  stop?: string;
  /** Run when a turn finishes after {@link NOTIFICATION_AFTER_MS} or more. */
  notification?: string;
}

export const DEFAULT_HOOK_TIMEOUT_MS = 60_000;
/** A turn must take at least this long before the notification hook fires. */
export const NOTIFICATION_AFTER_MS = 30_000;

export interface HookRun {
  stdout: string;
  exitCode: number;
  /** True when the process was killed by the timeout (exitCode is null-ish). */
  timedOut: boolean;
}

/** Run one hook command, feeding `input` as JSON on stdin. */
export function runHook(command: string, input: unknown, timeoutMs = DEFAULT_HOOK_TIMEOUT_MS): Promise<HookRun> {
  return new Promise((resolve, reject) => {
    // `detached: true` makes the shell its own process-group leader, so the
    // timeout can SIGKILL the WHOLE group (`kill(-pid)`) — killing only the
    // shell would leave e.g. `sleep 5` alive holding the stdout pipe, and
    // `close` would not fire until it exits.
    const child = spawn(command, { shell: true, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d; });
    child.stderr.on('data', (d: Buffer) => { stderr += d; });
    const timer = setTimeout(() => {
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ }
    }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      // SIGKILL by our timeout → code is null. A non-zero exit is NOT an error:
      // hooks signal conditions via exit codes (CC semantics) and the payload
      // on stdout, so we resolve and let the caller decide.
      resolve({ stdout, exitCode: code ?? -1, timedOut: code === null });
    });
    // A hook that exits before reading stdin (e.g. `exit 3`) closes the pipe;
    // writing the payload then raises EPIPE — expected, never an error.
    child.stdin.on('error', () => { /* EPIPE: child exited early */ });
    child.stdin.end(JSON.stringify(input));
  });
}

/** True when a hook rule's matcher regex hits `${toolName}\n${JSON.stringify(input)}`. */
export function matchesHook(rule: HookRule, toolName: string, input: unknown): boolean {
  try {
    return new RegExp(rule.matcher).test(`${toolName}\n${JSON.stringify(input)}`);
  } catch {
    return false; // a broken regex must never break the agent
  }
}

export interface PreToolUseDecision {
  denied: boolean;
  reason?: string;
  additionalContext?: string;
}

/**
 * Run every matching PreToolUse hook in order and merge their decisions.
 * JSON stdout may carry `{ permissionDecision: 'allow'|'deny', reason?,
 * additionalContext? }` (Claude Code protocol); any other stdout is treated as
 * additional context for the model.
 */
export async function runPreToolUseHooks(
  rules: HookRule[],
  toolName: string,
  input: unknown,
): Promise<PreToolUseDecision> {
  let denied = false;
  let reason: string | undefined;
  let context = '';
  for (const rule of rules) {
    if (!matchesHook(rule, toolName, input)) continue;
    let run: HookRun;
    try {
      run = await runHook(rule.command, { toolName, toolInput: input }, rule.timeoutMs);
    } catch {
      continue; // hook failed to spawn — advisory, skip
    }
    const out = run.stdout.trim();
    if (!out) continue;
    try {
      const parsed: unknown = JSON.parse(out);
      if (typeof parsed === 'object' && parsed !== null) {
        const p = parsed as { permissionDecision?: string; reason?: string; additionalContext?: string };
        if (p.permissionDecision === 'deny') {
          denied = true;
          reason = typeof p.reason === 'string' && p.reason ? p.reason : 'denied by hook';
        }
        if (typeof p.additionalContext === 'string' && p.additionalContext) {
          context += p.additionalContext;
        } else if (!('permissionDecision' in p) && !('additionalContext' in p) && !('reason' in p)) {
          // A JSON OBJECT that is not the CC protocol shape is free-form context
          // too (the doc: "any other stdout is treated as additional context").
          // Only objects carrying protocol keys are swallowed.
          context += out;
        }
      } else if (!denied) {
        context += out;
      }
    } catch {
      if (!denied) context += out; // non-JSON stdout = free-form context
    }
  }
  return { denied, ...(reason ? { reason } : {}), ...(context ? { additionalContext: context } : {}) };
}
