import { For, type JSX } from 'solid-js';
import { ToolCard } from './tool-card.tsx';
import { Thinking } from './thinking.tsx';
import { StreamText } from './stream.tsx';

export function MessageContent(props: {
  content: any[];
  renderText?: (text: string) => JSX.Element;
}) {
  const renderDefault = (text: string) => <StreamText text={text} />;
  const render = props.renderText || renderDefault;
  
  return (
    <For each={props.content}>
      {(c: any) => (
        <>
          {/* ContentBlock 格式 */}
          {c.type === 'text' && render(c.text)}
          {c.type === 'thinking' && <Thinking text={c.thinking} />}
          {c.type === 'tool_call' && <ToolCard tool={c} status="done" />}
          
          {/* CoreEvent 格式 (用于实时事件渲染) */}
          {c.type === 'text_delta' && render(c.text)}
          {c.type === 'thinking_delta' && <Thinking text={c.thinking} />}
          {c.type === 'tool_call_start' && <ToolCard tool={{ id: c.id, name: c.name, input: {} }} status="running" />}
          {c.type === 'tool_result' && <ToolCard tool={{ id: c.id, name: c.name, input: c.input, content: c.content }} status="done" />}
          {c.type === 'delegate_start' && <div class="event-line">→ subagent [{c.agent}] {c.task}</div>}
        </>
      )}
    </For>
  );
}