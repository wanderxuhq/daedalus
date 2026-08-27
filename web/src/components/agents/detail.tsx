import { createEffect, createSignal, Show } from 'solid-js';
import { state, submitSubagentPrompt } from '../../stores.ts';
import { getSubagentMessages, chatAgent } from '../../api.ts';
import { Badge } from '../common/badge.tsx';
import { ChatView } from '../chat/view.tsx';
import { ChatInput } from '../chat/input.tsx';
import { t } from '../../i18n.ts';
import type { Message } from '../../types/messages.ts';
import type { CoreEvent } from '../../../../src/core/events.ts';

export function AgentDetail(props: { name: string }) {
  const agent = () => state().subagents.find((a) => a.name === props.name);
  const [history, setHistory] = createSignal<Message[]>([]);
  const [sending, setSending] = createSignal(false);

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

  const onSend = async (prompt: string) => {
    submitSubagentPrompt(prompt); // 本地立即回显
    setSending(true);
    const result = await chatAgent(props.name, prompt);
    if (result.status === 'error') {
      // 发送失败：服务端不会推送事件，回显一条错误消息
      // TODO: 可以将错误显示到 subagentMessages 中
    }
    setSending(false);
  };

  // 实时事件：过滤掉不支持渲染的类型
  const liveEvents = () => {
    const a = agent();
    if (!a) return [];
    return a.events.filter(e =>
      e.type === 'text_delta' ||
      e.type === 'thinking_delta' ||
      e.type === 'tool_call_start' ||
      e.type === 'tool_result' ||
      e.type === 'delegate_start'
    ) as CoreEvent[];
  };

  return (
    <div class="agent-detail">
      <a class="back" href="#/">{t('agent.back')}</a>
      <h2>subagent: {props.name}</h2>
      <Show when={agent()}>
        {(a) => (
          <div class="agent-meta">
            <Badge status={a().status} />
            <span class="agent-task">{a().task}</span>
          </div>
        )}
      </Show>
      <div class="agent-chat">
        <ChatView
          messages={history().filter(m => m.role !== 'system')}
          streamingContent={liveEvents()}
          cwd={state().cwd}
          class="agent-chat-stream"
        />
        <ChatInput
          disabled={sending() || (agent()?.status === 'done')}
          autoApprove={false}
          onSend={onSend}
          onToggleAuto={() => {}}
        />
      </div>
    </div>
  );
}
