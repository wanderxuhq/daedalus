import { createEffect, createSignal, For, Show } from 'solid-js';
import { state } from '../../stores.ts';
import { getSubagentMessages } from '../../api.ts';
import { Badge } from '../common/badge.tsx';
import { MessageContent } from '../chat/message-content.tsx';
import { t } from '../../i18n.ts';

export function AgentDetail(props: { name: string }) {
  const agent = () => state().subagents.find((a) => a.name === props.name);
  const [history, setHistory] = createSignal<any[]>([]);
  createEffect(() => {
    const name = props.name;
    void getSubagentMessages(name).then((ms) => setHistory(ms)).catch(() => {});
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
              <For each={history().filter((m: any) => m.role !== 'system')}>
                {(m: any) => (
                  <MessageContent content={m.content} />
                )}
              </For>
              {/* 实时 tagged 事件：state-model 已按 agent 累积到 a().events */}
              <MessageContent content={a().events} />
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
