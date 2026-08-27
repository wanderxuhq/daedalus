import { Show } from 'solid-js';
import { MessageContent } from './message-content.tsx';
import type { Message } from '../../types/messages.ts';

export function MessageBubble(props: { message: Message; cwd?: string }) {
  const m = () => props.message;
  // 用户消息：只渲染有文本内容的（过滤掉只有 tool_result 的用户消息，避免空气泡）
  const textContent = () => m().role === 'user'
    ? m().content.filter(c => c.type === 'text').map(c => c.type === 'text' ? c.text : '').join('\n')
    : null;
  return (
    <Show when={m().role !== 'user' || textContent()}>
      <div class={`msg msg-${m().role}`}>
        {m().role === 'user' ? (
          <div class="msg-text">{textContent()}</div>
        ) : (
          <MessageContent content={m().content} cwd={props.cwd} />
        )}
      </div>
    </Show>
  );
}
