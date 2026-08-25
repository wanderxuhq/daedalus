import { createEffect, createSignal, For, Show } from 'solid-js';
import { state } from '../../stores.ts';
import { getSubagentMessages } from '../../api.ts';
import { Badge } from '../common/badge.tsx';
import { MessageContent } from '../chat/message-content.tsx';
import { t } from '../../i18n.ts';
import type { Message } from '../../types/messages.ts';
import type { CoreEvent } from '../../../../src/core/events.ts';

export function AgentDetail(props: { name: string }) {
  const agent = () => state().subagents.find((a) => a.name === props.name);
  const [history, setHistory] = createSignal<Message[]>([]);
  createEffect(() => {
    const name = props.name;
    void getSubagentMessages(name).then((ms) => setHistory(ms as Message[])).catch(() => {});
  });
  // Re-fetch history when subagent completes to ensure we have the final message
  createEffect(() => {
    const a = agent();
    if (a && a.status === 'done') {
      void getSubagentMessages(props.name).then((ms) => setHistory(ms as Message[])).catch(() => {});
    }
  });
  return (
    <div class="agent-detail">
      <a class="back" href="#/">{t('agent.back')}</a>
      <h2>subagent: {props.name}</h2>
      <Show when={agent()}>
        {(a) => (
          <>
            <div class="agent-meta">
              <Badge status={a().status} />
              <span class="agent-task">{a().task}</span>
            </div>
            <div class="agent-events">
              {/* 子代理会话同样以 role:'system' 存自己的提示词 —— 不渲染。 */}
              <For each={history().filter(m => m.role !== 'system')}>
                {(m: Message) => (
                  <MessageContent content={m.content} />
                )}
              </For>
              {/* 实时 tagged 事件：state-model 已按 agent 累积到 a().events */}
              {/* 过滤掉不支持渲染的事件类型 */}
              <MessageContent content={a().events.filter(e => 
                e.type === 'text_delta' || 
                e.type === 'thinking_delta' || 
                e.type === 'tool_call_start' || 
                e.type === 'tool_result' || 
                e.type === 'delegate_start'
              )} />
            </div>
          </>
        )}
      </Show>
      <div class="agent-interaction reserved">
        <span>{t('agent.interAgent')}</span>
      </div>
    </div>
  );
}
