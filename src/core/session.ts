import type { Message } from '../ai/types.ts';
import { EventBus } from './events.ts';

/** Serializable snapshot of a session — what SessionStore persists and resume seeds from. */
export interface SessionState {
  messages: Message[];
  loadedSkills: string[];
}

export class Session {
  readonly bus = new EventBus();
  private msgs: Message[] = [];
  private skills = new Set<string>();
  /** Monotonically increasing counter for stable message identity (dedup across clones). */
  private nextMsgId = 1;
  /** Queue of user-injected messages, processed on the subagent's next loop iteration. */
  private pendingQueue: Message[] = [];
  /** System prompt text set at creation time; used by startSubagentLoop to re-init consistently. */
  systemPromptText: string | null = null;

  start(): void {
    this.bus.emit({ type: 'session_start' });
  }

  dispose(): void {
    this.bus.emit({ type: 'session_end' });
  }

  addMessage(m: Message): void {
    if (m._id === undefined) m._id = this.nextMsgId++;
    this.msgs.push(m);
  }

  /** Inject a user message into the pending queue, processed on the subagent's next loop iteration. */
  addPendingMessage(m: Message): void {
    this.pendingQueue.push(m);
  }

  /** Drain all pending messages into the conversation history. Returns whether any new messages were added. */
  drainPendingMessages(): boolean {
    if (this.pendingQueue.length === 0) return false;
    this.msgs.push(...this.pendingQueue);
    this.pendingQueue = [];
    return true;
  }

  /** Whether there are pending user messages. */
  hasPendingMessages(): boolean {
    return this.pendingQueue.length > 0;
  }

  getMessages(): Message[] {
    return this.msgs;
  }

  markSkillLoaded(name: string): void {
    if (this.skills.has(name)) return;
    this.skills.add(name);
    this.bus.emit({ type: 'skill_load', name });
  }

  isSkillLoaded(name: string): boolean {
    return this.skills.has(name);
  }

  getLoadedSkills(): string[] {
    return [...this.skills];
  }

  /** Deep copy of messages + skills so callers cannot mutate internal state. */
  getState(): SessionState {
    return {
      messages: this.msgs.map((m) => ({
        role: m.role,
        content: m.content.map((b) => structuredClone(b)),
        _id: m._id,
      })),
      loadedSkills: [...this.skills],
    };
  }

  /** Wholesale history swap (trimming / restore). Callers pass fresh arrays. */
  replaceMessages(msgs: Message[]): void {
    this.msgs = msgs;
  }

  /** Restore the loaded-skill set without emitting skill_load events. */
  restoreLoadedSkills(names: string[]): void {
    this.skills = new Set(names);
  }
}

/**
 * Named pool of reusable subagent sessions. A `delegate` call carrying an
 * `agent` name reuses the pooled session, so the subagent continues from its
 * previous run's history ("keep researching X from where you left off")
 * instead of starting cold every time. Live in the engine, disposed with it;
 * never persisted.
 */
export class SessionPool {
  private map = new Map<string, Session>();

  /** Get (creating and starting on first use) the session for `key`. */
  get(key: string): Session {
    let s = this.map.get(key);
    if (!s) {
      s = new Session();
      s.start();
      this.map.set(key, s);
    }
    return s;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  /** Dispose and forget a named session; the next get() starts fresh. */
  reset(key: string): void {
    const s = this.map.get(key);
    if (s) {
      s.dispose();
      this.map.delete(key);
    }
  }

  /** Snapshot of every pooled session's name and history (read-only). */
  entries(): Array<{ key: string; session: Session }> {
    return [...this.map.entries()].map(([key, s]) => ({ key, session: s }));
  }

  /** Names of all pooled sessions, in creation order. */
  keys(): string[] {
    return [...this.map.keys()];
  }

  /** Dispose every pooled session (engine shutdown). */
  clear(): void {
    for (const s of this.map.values()) s.dispose();
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}
