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

  start(): void {
    this.bus.emit({ type: 'session_start' });
  }

  dispose(): void {
    this.bus.emit({ type: 'session_end' });
  }

  addMessage(m: Message): void {
    this.msgs.push(m);
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
