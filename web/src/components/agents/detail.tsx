import { createSignal, Show } from 'solid-js';
import { state, submitSubagentPrompt } from '../../stores.ts';
import { chatAgent } from '../../api.ts';
import { Badge } from '../common/badge.tsx';
import { ChatView } from '../chat/view.tsx';
import { ChatInput } from '../chat/input.tsx';
import { t } from '../../i18n.ts';

export function AgentDetail(props: { name: string }) {
  const agent = () => state().subagents.find((a) => a.name === props.name);
  const [sending, setSending] = createSignal(false);

  const onSend = async (prompt: string) => {
    submitSubagentPrompt(props.name, prompt);
    setSending(true);
    const result = await chatAgent(props.name, prompt);
    if (result.status === 'error') {
      // TODO: show error in UI
    }
    setSending(false);
  };

  return (
    <div class="agent-detail">
      <a class="back" href="#/">{t('agent.back')}</a>
      <h2>subagent: {props.name}</h2>
      <Show when={agent()}>
        {(a) => (
          <div class="agent-meta">
            <Badge status={a().status} />
          </div>
        )}
      </Show>
      <div class="agent-chat">
        <Show when={agent()}>
          {(a) => (
            <ChatView
              messages={a().messages}
              streamingContent={a().streamingMessage ? [a().streamingMessage!] : undefined}
              cwd={state().cwd}
              class="agent-chat-stream"
            />
          )}
        </Show>
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
