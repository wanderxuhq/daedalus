import { For } from 'solid-js';
import { ToolCard } from './tool-card.tsx';
import { Thinking } from './thinking.tsx';
import { StreamText } from './stream.tsx';

export function MessageBubble(props: { message: any }) {
  const m = () => props.message;
  return (
    <div class={`msg msg-${m().role}`}>
      {m().role === 'user' ? (
        <div class="msg-text">{m().content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')}</div>
      ) : (
        <For each={m().content}>
          {(c: any) => (
            <>
              {c.type === 'text' && <StreamText text={c.text} />}
              {c.type === 'thinking' && <Thinking text={c.thinking} />}
              {c.type === 'tool_call' && <ToolCard tool={c} status="done" />}
            </>
          )}
        </For>
      )}
    </div>
  );
}
