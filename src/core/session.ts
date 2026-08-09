import type { Message } from '../ai/types.ts';
import { EventBus } from './events.ts';

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
}
