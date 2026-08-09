import type { Message } from '../ai/types.ts';

export class MessageHistory {
  private msgs: Message[] = [];
  add(m: Message): void { this.msgs.push(m); }
  get(): Message[] { return this.msgs; }
}
