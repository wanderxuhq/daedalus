import { createEffect, createMemo, createSignal, For, onCleanup, Show } from 'solid-js';
import { MessageBubble } from './message.tsx';
import { MessageContent, type RenderableContent } from './message-content.tsx';
import { sendWsMessage } from '../../ws.ts';
import { PermissionCard } from './permission-card.tsx';
import type { Message } from '../../types/messages.ts';
import type { CoreEvent } from '../../../../src/core/events.ts';

/** 可渲染的内容项：已完成的消息 或 实时事件。 */
type RenderableItem =
  | { kind: 'message'; data: Message }
  | { kind: 'events'; data: unknown[] };

/**
 * 统一的聊天消息流组件：主对话和 subagent 都用它。
 * 只负责消息渲染 + 自动滚动 + 权限卡片；输入栏和布局由消费者控制。
 */
export function ChatView(props: {
  /** 已完成的消息列表。 */
  messages: Message[];
  /** 实时流式内容（主对话传 streamingMessage，subagent 传 CoreEvent[]）。 */
  streamingContent?: Message[] | CoreEvent[];
  /** 待处理的权限请求。 */
  pendingPermission?: { id: string; action: string; target: string } | null;
  /** 工作目录。 */
  cwd?: string;
  /** CSS class 附加到根元素（如 agent-detail）。 */
  class?: string;
}) {
  let chatStreamRef: HTMLDivElement | undefined;
  const [isNearBottom, setIsNearBottom] = createSignal(true);

  // 合并历史消息 + 流式内容为统一的渲染列表
  const items = createMemo<RenderableItem[]>(() => {
    const result: RenderableItem[] = props.messages.map((m) => ({ kind: 'message', data: m }));
    const sc = props.streamingContent;
    if (sc && sc.length > 0) {
      if (sc.length > 0 && 'role' in sc[0]) {
        // streamingMessage: Message[]
        for (const m of sc as Message[]) {
          result.push({ kind: 'message', data: m });
        }
      } else {
        // subagent live events: CoreEvent[]
        result.push({ kind: 'events', data: sc });
      }
    }
    return result;
  });

  // Auto-scroll：用户在底部时，新消息/流式内容到达后自动滚到底部
  createEffect(() => {
    const _ = items();
    const _2 = props.pendingPermission;
    queueMicrotask(() => {
      if (chatStreamRef && isNearBottom()) {
        chatStreamRef.scrollTo({ top: chatStreamRef.scrollHeight, behavior: 'smooth' });
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

  return (
    <div class={props.class ?? 'chat-stream'} ref={chatStreamRef}>
      <For each={items()}>
        {(item) =>
          item.kind === 'message'
            ? <MessageBubble message={item.data} cwd={props.cwd} />
            : <MessageContent content={item.data as RenderableContent[]} cwd={props.cwd} />
        }
      </For>
      <Show when={props.pendingPermission}>
        <PermissionCard pending={props.pendingPermission!} send={(m) => sendWsMessage(m)} />
      </Show>
    </div>
  );
}
