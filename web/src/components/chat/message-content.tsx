import { For, type JSX } from 'solid-js';
import { ToolCard } from './tool-card.tsx';
import { Thinking } from './thinking.tsx';
import { StreamText } from './stream.tsx';
import type { ContentBlock } from '../../types/messages.ts';
import type { CoreEvent } from '../../../../src/core/events.ts';

/** Union type for all renderable content items */
type RenderableContent =
  | ContentBlock
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'tool_call_start'; id: string; name: string }
  | { type: 'tool_result'; id: string; name: string; input: unknown; content: string; isError?: boolean; diff?: string }
  | { type: 'delegate_start'; agent?: string; task: string };

export function MessageContent(props: {
  content: RenderableContent[];
  renderText?: (text: string) => JSX.Element;
  cwd?: string;
}) {
  const renderDefault = (text: string) => <StreamText text={text} />;
  const render = props.renderText || renderDefault;
  
  return (
    <For each={props.content}>
      {(c: RenderableContent) => (
        <>
          {/* ContentBlock 格式 */}
          {c.type === 'text' && render(c.text)}
          {c.type === 'thinking' && <Thinking text={c.thinking} />}
          {c.type === 'tool_call' && <ToolCard tool={{ id: c.id, name: c.name, input: c.input, content: c.resultContent, diff: c.diff, status: c.status === 'error' ? 'error' : 'done' }} status={c.status === 'error' ? 'error' : 'done'} cwd={props.cwd} />}
          
          {/* CoreEvent 格式 (用于实时事件渲染) */}
          {c.type === 'text_delta' && render(c.text)}
          {c.type === 'thinking_delta' && <Thinking text={c.thinking} />}
          {c.type === 'tool_call_start' && <ToolCard tool={{ id: c.id, name: c.name, input: {}, status: 'running' }} status="running" cwd={props.cwd} />}
          {c.type === 'tool_result' && 'id' in c && <ToolCard tool={{ id: c.id, name: c.name, input: c.input, content: c.content, diff: c.diff, status: 'done' }} status="done" cwd={props.cwd} />}
          {c.type === 'delegate_start' && <div class="event-line">→ subagent [{c.agent}] {c.task}</div>}
        </>
      )}
    </For>
  );
}