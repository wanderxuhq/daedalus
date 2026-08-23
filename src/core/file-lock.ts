import { resolve as resolvePath } from 'node:path';

/**
 * Shared, writer-preferring read/write file locks so concurrent agents (the
 * main agent + parallel subagents from delegateMany) don't silently clobber
 * each other's files.
 *
 * Semantics:
 * - Multiple readers may hold a path at once (concurrent exploration of the
 *   same file is safe and stays parallel).
 * - A writer excludes both readers and other writers (`write` overwrites,
 *   `edit` is a read-modify-write that must be atomic against the rest of the
 *   team).
 * - Writers are preferred over NEW readers: once a writer queues, later
 *   readers join the queue instead of slipping in, so a writer can never be
 *   starved by a steady stream of reads.
 * - Acquire times out instead of waiting forever (default 30s). The timeout
 *   error names the current holder so the orchestrating main agent can
 *   arbitrate the conflict. The timeout also breaks AB-BA deadlocks: an agent
 *   holding A and waiting on B fails after the budget and releases A.
 *
 * The registry is an engine-level singleton (one per DaedalusEngine, shared by
 * the main agent and every subagent via ToolContext.locks) — never a module
 * singleton, so tests and multiple engine instances don't pollute each other.
 * Locks are advisory and in-memory only: they coordinate Daedalus's own
 * agents, not external processes, and a crash releases everything (nothing is
 * persisted). Arbitrary shell writes (`sed -i`, `mv`, `cat >>`) bypass the
 * locks — that blind spot is documented, not solved here.
 */
export const DEFAULT_LOCK_TIMEOUT_MS = 30_000;

export interface LockOptions {
  /** Label of the lock holder for conflict reporting ('main', subagent name, …). */
  holder?: string;
  /** How long to wait for the lock before failing with a conflict. */
  timeoutMs?: number;
}

/** A lock that could not be granted within its timeout; names the current holder. */
export class LockTimeoutError extends Error {
  readonly path: string;
  readonly kind: 'read' | 'write';
  readonly holder: string;
  readonly timeoutMs: number;
  readonly heldBy: string;

  constructor(path: string, kind: 'read' | 'write', holder: string, timeoutMs: number, heldBy: string) {
    super(`File ${kind} lock on ${path} timed out after ${timeoutMs}ms (currently held by ${heldBy})`);
    this.name = 'LockTimeoutError';
    this.path = path;
    this.kind = kind;
    this.holder = holder;
    this.timeoutMs = timeoutMs;
    this.heldBy = heldBy;
  }
}

interface Waiter {
  kind: 'read' | 'write';
  holder: string;
  ok: (release: () => void) => void;
  fail: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** One path's lock state: active holders plus queued readers and writers. */
class RWLock {
  private readonly path: string;
  private readonly defaultTimeoutMs: number;
  private readers = 0;
  private writer: string | undefined;
  private writeWaiters: Waiter[] = [];
  private readWaiters: Waiter[] = [];

  constructor(path: string, defaultTimeoutMs: number) {
    this.path = path;
    this.defaultTimeoutMs = defaultTimeoutMs;
  }

  acquire(kind: 'read' | 'write', holder: string, timeoutMs?: number): Promise<() => void> {
    const timeout = timeoutMs ?? this.defaultTimeoutMs;
    return new Promise<() => void>((ok, fail) => {
      const waiter: Waiter = {
        kind,
        holder,
        ok,
        fail,
        timer: setTimeout(() => {
          this.remove(waiter);
          fail(new LockTimeoutError(this.path, kind, holder, timeout, this.heldBy()));
        }, timeout),
      };
      if (kind === 'write') this.writeWaiters.push(waiter);
      else this.readWaiters.push(waiter);
      this.tryGrant();
    });
  }

  /**
   * Writer-preferring grant policy:
   * - a write in flight blocks everything;
   * - a queued writer blocks NEW readers (it can't starve) and takes over as
   *   soon as the lock is idle;
   * - only when no writer is active or queued are queued readers granted.
   */
  private tryGrant(): void {
    if (this.writer !== undefined) return;
    if (this.writeWaiters.length > 0) {
      if (this.readers === 0) {
        const w = this.writeWaiters.shift()!;
        clearTimeout(w.timer);
        this.writer = w.holder;
        w.ok(() => this.release('write'));
      }
      return;
    }
    while (this.readWaiters.length > 0) {
      const r = this.readWaiters.shift()!;
      clearTimeout(r.timer);
      this.readers++;
      r.ok(() => this.release('read'));
    }
  }

  private release(kind: 'read' | 'write'): void {
    if (kind === 'read') this.readers = Math.max(0, this.readers - 1);
    else this.writer = undefined;
    this.tryGrant();
  }

  /** Drop a timed-out waiter so it no longer blocks the queue. */
  private remove(waiter: Waiter): void {
    const q = waiter.kind === 'write' ? this.writeWaiters : this.readWaiters;
    const i = q.indexOf(waiter);
    if (i !== -1) q.splice(i, 1);
    this.tryGrant();
  }

  /** A human-readable description of who currently holds or waits on the lock. */
  private heldBy(): string {
    if (this.writer !== undefined) return `writer ${this.writer}`;
    if (this.readers > 0) return `${this.readers} reader(s)`;
    const w = this.writeWaiters[0];
    if (w) return `queued writer ${w.holder}`;
    const r = this.readWaiters[0];
    if (r) return `queued reader ${r.holder}`;
    return 'nobody';
  }
}

/**
 * Registry of per-path RW locks, keyed by resolved absolute path so
 * `src/a.ts` and `./src/a.ts` share one lock. One instance per engine.
 */
export class FileLockRegistry {
  private locks = new Map<string, RWLock>();
  private readonly defaultTimeoutMs: number;

  constructor(defaultTimeoutMs: number = DEFAULT_LOCK_TIMEOUT_MS) {
    this.defaultTimeoutMs = defaultTimeoutMs;
  }

  /** Shared read lock: concurrent readers allowed; blocked by any writer. */
  acquireRead(path: string, opts: LockOptions = {}): Promise<() => void> {
    return this.lockFor(path).acquire('read', opts.holder ?? 'unknown', opts.timeoutMs);
  }

  /** Exclusive write lock: blocks readers and writers; writer-preferring. */
  acquireWrite(path: string, opts: LockOptions = {}): Promise<() => void> {
    return this.lockFor(path).acquire('write', opts.holder ?? 'unknown', opts.timeoutMs);
  }

  /** Drop all lock state (engine shutdown). Active locks are simply forgotten. */
  clear(): void {
    this.locks.clear();
  }

  private lockFor(path: string): RWLock {
    const key = resolvePath(path);
    let lock = this.locks.get(key);
    if (!lock) {
      lock = new RWLock(key, this.defaultTimeoutMs);
      this.locks.set(key, lock);
    }
    return lock;
  }
}
