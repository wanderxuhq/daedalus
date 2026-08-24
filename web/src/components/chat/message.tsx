import { For } from 'solid-js';
import { MessageContent } from './message-content.tsx';

export function MessageBubble(props: { message: any }) {
  const m = () => props.message;
  return (
    <div class={`msg msg-${m().role}`}>
      {m().role === 'user' ? (
        <div class="msg-text">{m().content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')}</div>
      ) : (
        <MessageContent content={m().content} />
      )}
    </div>
  );
}
