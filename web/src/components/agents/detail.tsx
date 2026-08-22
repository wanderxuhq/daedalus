import { createEffect, createSignal, For, Show } from 'solid-js';
import { state } from '../../stores.ts';
import { getSubagentMessages } from '../../api.ts';
import { Badge } from '../common/badge.tsx';
import { ToolCard } from '../chat/tool-card.tsx';
import { Thinking } from '../chat/thinking.tsx';

export function AgentDetail(props: { name: string }) {
  const agent = () => state().subagents.find((a) => a.name === props.name);
  const [history, setHistory] = createSignal<any[]>([]);
  createEffect(() => {
    const name = props.name;
    void getSubagentMessages(name).then((ms) => setHistory(ms)).catch(() => {});
  });
  return (
    <div class="agent-detail">
      <a class="back" href="#/">← 返回</a>
      <h2>subagent: {props.name}</h2>
      <Show when={agent()}>
        {(a) => (
          <>
            <div class="agent-meta">
              <Badge status={a().status} />
              <span class="agent-task">{a().task}</span>
            </div>
            <div class="agent-events">
              <For each={history()}>
                {(m: any) => (
                  <For each={m.content}>
                    {(c: any) => (
                      <>
                        {c.type === 'text' && <div class="msg-text">{c.text}</div>}
                        {c.type === 'thinking' && <Thinking text={c.thinking} />}
                        {c.type === 'tool_call' && <ToolCard tool={c} status="done" />}
                      </>
                    )}
                  </For>
                )}
              </For>
              {/* 实时 tagged 事件：state-model 已按 agent 累积到 a().events */}
              <For each={a().events}>
                {(e: any) => (
                  <>
                    {e.type === 'text_delta' && <div class="msg-text">{e.text}</div>}
                    {e.type === 'thinking_delta' && <div class="thinking-body">{e.thinking}</div>}
                    {e.type === 'tool_call_start' && <ToolCard tool={{ name: e.name, input: {} }} status="running" />}
                    {e.type === 'tool_result' && <div class="tool-content">{e.content}</div>}
                    {e.type === 'delegate_start' && <div class="event-line">→ subagent [{e.agent}] {e.task}</div>}
                  </>
                )}
              </For>
            </div>
          </>
        )}
      </Show>
      <div class="agent-interaction reserved">
        <span>agent 间交流：待开放</span>
      </div>
    </div>
  );
}
