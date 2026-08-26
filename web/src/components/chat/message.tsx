import { For } from 'solid-js';
import { MessageContent } from './message-content.tsx';
import type { Message } from '../../types/messages.ts';

export function MessageBubble(props: { message: Message; cwd?: string }) {
  const m = () => props.message;
  return (
    <div class={`msg msg-${m().role}`}>
      {m().role === 'user' ? (
        <div class="msg-text">{m().content.filter(c => c.type === 'text').map(c => c.type === 'text' ? c.text : '').join('\n')}</div>
      ) : (
        <MessageContent content={m().content} cwd={props.cwd} />
      )}
    </div>
  );
}
