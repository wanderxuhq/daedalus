import { createEffect, createSignal, For, onCleanup, Show } from 'solid-js';
import { MessageBubble } from './message.tsx';
import { MessageContent, type RenderableContent } from './message-content.tsx';
import { sendWsMessage } from '../../ws.ts';
import { PermissionCard } from './permission-card.tsx';
import type { Message } from '../../types/messages.ts';
import type { CoreEvent } from '../../../../src/core/events.ts';

/**
 * 统一的聊天消息流组件：主对话和 subagent 都用它。
 * 只负责消息渲染 + 自动滚动 + 权限卡片；输入栏和布局由消费者控制。
 *
 * 已完成的消息和流式内容分开渲染。completed messages 的引用稳定，
 * 不受 streamingVersion 变化影响，<For> 不会误判导致全量重建。
 */
export function ChatView(props: {
  /** 已完成的消息列表。 */
  messages: Message[];
  /** 实时流式内容（主对话传 streamingMessage，subagent 传 CoreEvent[]）。 */
  streamingContent?: Message[] | CoreEvent[];
  /** 流式消息版本号：内容原地修改时递增，触发 UI 响应式更新。 */
  streamingVersion?: number;
  /** 待处理的权限请求。 */
  pendingPermission?: { id: string; action: string; target: string } | null;
  /** 工作目录。 */
  cwd?: string;
  /** CSS class 附加到根元素（如 agent-detail）。 */
  class?: string;
}) {
  let chatStreamRef: HTMLDivElement | undefined;
  const [isNearBottom, setIsNearBottom] = createSignal(true);

  // Auto-scroll：用户在底部时，新消息/流式内容到达后自动滚到底部
  // 使用 'instant' 替代 'smooth'，避免多个平滑滚动动画互相干扰导致跳动
  createEffect(() => {
    const _msgs = props.messages;
    const _sc = props.streamingContent;
    const _v = props.streamingVersion;
    queueMicrotask(() => {
      if (chatStreamRef && isNearBottom()) {
        chatStreamRef.scrollTo({ top: chatStreamRef.scrollHeight, behavior: 'instant' });
      }
    });
  });

  // 持续追踪滚动位置，在 scroll 事件中更新 signal
  const updateNearBottom = () => {
    if (!chatStreamRef) return;
    const { scrollTop, scrollHeight, clientHeight } = chatStreamRef;
    setIsNearBottom(scrollHeight - scrollTop - clientHeight < 120);
  };
  createEffect(() => {
    const el = chatStreamRef;
    if (!el) return;
    el.addEventListener('scroll', updateNearBottom, { passive: true });
    onCleanup(() => el.removeEventListener('scroll', updateNearBottom));
  });

  // 判断 streamingContent 是 Message[] 还是 CoreEvent[]
  const isStreamMessages = () => {
    const sc = props.streamingContent;
    return sc != null && sc.length > 0 && 'role' in sc[0];
  };

  const hasStreaming = () => {
    const sc = props.streamingContent;
    return sc != null && sc.length > 0;
  };

  return (
    <div class={props.class ?? 'chat-stream'} ref={chatStreamRef}>
      {/* 已完成的消息：引用稳定，<For> 不会误判导致全量重建 */}
      <For each={props.messages}>
        {(msg) => <MessageBubble message={msg} cwd={props.cwd} />}
      </For>
      {/* 流式内容：单独渲染，streamingVersion 变化不影响已完成消息的 <For> */}
      <Show when={isStreamMessages()}>
        <For each={props.streamingContent as Message[]}>
          {(msg) => <MessageBubble message={msg} cwd={props.cwd} />}
        </For>
      </Show>
      <Show when={hasStreaming() && !isStreamMessages()}>
        <MessageContent content={props.streamingContent as RenderableContent[]} cwd={props.cwd} />
      </Show>
      <Show when={props.pendingPermission}>
        <PermissionCard pending={props.pendingPermission!} send={(m) => sendWsMessage(m)} />
      </Show>
    </div>
  );
}
