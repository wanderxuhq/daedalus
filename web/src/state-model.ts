import type { CoreEvent, SubagentInfo as SubagentInfoBase } from '../../src/core/events.ts';
import { TERMINALS } from '../../src/core/events.ts';
import type { EventEnvelope, SnapshotPayload } from './types.ts';
import type { Message } from '../../src/ai/types.ts';
import type { ContentBlock } from './types/messages.ts';
import type { StreamingMessage, StreamingContentBlock } from './types/messages.ts';

export interface SubagentInfo extends SubagentInfoBase {
  /** 该 agent 的实时 CoreEvent 累积（detail 页 live 渲染用；snapshot 重置）。 */
  events: CoreEvent[];
}

export interface UiState {
  /** 渲染列表：快照回填的存量消息 + 本地回显的用户消息 + done 落地的回复。 */
  messages: Message[];
  subagents: SubagentInfo[];
  running: boolean;
  log: CoreEvent[];
  pendingPermission: { id: string; action: string; target: string } | null;
  autoApprove: boolean;
  /** 最近一次主会话 error 事件的文案（横幅展示；快照/新一轮提交时清除）。 */
  error: string | null;
  /** 当前正在查看的子代理名称，null 表示查看主会话。 */
  viewingSubagent: string | null;
  /** 当前查看的子代理的消息列表。 */
  subagentMessages: (Message | CoreEvent)[];
  /** 当前正在流式输出的助手消息（实时渲染用）。 */
  streamingMessage: StreamingMessage | null;
  /** 工作目录，用于在 UI 中格式化路径。 */
  cwd: string;
}

export function initialUiState(): UiState {
  return { messages: [], subagents: [], running: false, log: [], pendingPermission: null, autoApprove: false, error: null, viewingSubagent: null, subagentMessages: [], streamingMessage: null, cwd: '' };
}

/** 用户点发送：本地立即回显 user 消息（不等服务端），清掉上一次的错误和流式消息。 */
export function submitPrompt(state: UiState, prompt: string): UiState {
  return {
    ...state,
    error: null,
    streamingMessage: null, // 清空流式消息
    messages: [...state.messages, { role: 'user', content: [{ type: 'text', text: prompt }] }],
  };
}

/** 给子代理发消息：本地回显到 subagentMessages。 */
export function submitSubagentPrompt(state: UiState, prompt: string): UiState {
  return {
    ...state,
    error: null,
    subagentMessages: [...state.subagentMessages, { role: 'user', content: [{ type: 'text', text: prompt }] }],
  };
}

/** 更新流式消息：根据事件类型累积文本、思考和工具调用。 */
function updateStreamingMessage(state: UiState, ev: CoreEvent): StreamingMessage | null {
  // 如果没有流式消息且事件是文本/思考/工具调用开始，创建新的流式消息
  if (!state.streamingMessage) {
    if (ev.type === 'text_delta' || ev.type === 'thinking_delta' || ev.type === 'tool_call_start') {
      const content: StreamingContentBlock[] = [];
      if (ev.type === 'text_delta') {
        content.push({ type: 'text', text: ev.text });
      } else if (ev.type === 'thinking_delta') {
        content.push({ type: 'thinking', thinking: ev.thinking });
      } else if (ev.type === 'tool_call_start') {
        content.push({ type: 'tool_call', id: ev.id, name: ev.name, input: '', status: 'pending' });
      }
      return { role: 'assistant', content };
    }
    return null;
  }

  // 如果有流式消息，更新它
  const content = [...state.streamingMessage.content];
  switch (ev.type) {
    case 'text_delta': {
      // 查找最后一个文本块并追加（clone to avoid mutating the original）
      const lastText = [...content].reverse().find(c => c.type === 'text');
      if (lastText && lastText.type === 'text') {
        const idx = content.indexOf(lastText);
        content[idx] = { ...lastText, text: lastText.text + ev.text };
      } else {
        content.push({ type: 'text', text: ev.text });
      }
      break;
    }
    case 'thinking_delta': {
      // 查找最后一个思考块并追加（clone to avoid mutating the original）
      const lastThinking = [...content].reverse().find(c => c.type === 'thinking');
      if (lastThinking && lastThinking.type === 'thinking') {
        const idx = content.indexOf(lastThinking);
        content[idx] = { ...lastThinking, thinking: lastThinking.thinking + ev.thinking };
      } else {
        content.push({ type: 'thinking', thinking: ev.thinking });
      }
      break;
    }
    case 'tool_call_start': {
      // 添加新的工具调用
      content.push({ type: 'tool_call', id: ev.id, name: ev.name, input: '', status: 'pending' });
      break;
    }
    case 'tool_call_delta': {
      // 更新工具调用的输入（clone to avoid mutating the original）
      const toolCall = content.find(c => c.type === 'tool_call' && c.id === ev.id);
      if (toolCall && toolCall.type === 'tool_call') {
        const idx = content.indexOf(toolCall);
        content[idx] = { ...toolCall, input: toolCall.input + ev.inputDelta };
      }
      break;
    }
    case 'tool_result': {
      // 更新工具调用状态为完成（clone to avoid mutating the original）
      const toolCall = content.find(c => c.type === 'tool_call' && c.id === ev.id);
      if (toolCall && toolCall.type === 'tool_call') {
        const idx = content.indexOf(toolCall);
        content[idx] = {
          ...toolCall,
          status: ev.isError ? 'error' : 'done',
          resultContent: ev.content,
          ...(ev.diff !== undefined ? { diff: ev.diff } : {}),
        };
      }
      break;
    }
    default:
      break;
  }
  return { role: 'assistant', content };
}

export function applyEnvelope(state: UiState, env: EventEnvelope): UiState {
  if (env.type === 'snapshot') return mergeSnapshot(state, env);
  if (env.type === 'permission') return { ...state, pendingPermission: { id: env.id, action: env.action, target: env.target } };
  if (env.type === 'permission_cancel') return { ...state, pendingPermission: null };
  const ev = env.ev;
  if (ev.agent === undefined) {
    // main-session events: accumulate into the in-flight log
    const log = TERMINALS.has(ev.type) ? [] : [...state.log, ev];
    const running = log.length > 0;
    // 渲染断层修复：messages 只在 snapshot 时更新过，实时轮次从不上屏。
    // done 携带最终 assistant 消息 → 落进渲染列表；error → 横幅字段。
    let messages = state.messages;
    let error = state.error;
    let streamingMessage = state.streamingMessage;
    if ((ev.type === 'done' || ev.type === 'turn_done') && ev.message.role === 'assistant') {
      // Dedup: use _id (stable across deep clones) to prevent duplicates when
      // the same message appears in both a snapshot and a live event (reconnect),
      // or when turn_done is followed by done with the same content.
      // Fall back to reference equality when _id is absent (test helpers, legacy).
      const lastMsg = state.messages[state.messages.length - 1] as Message | undefined;
      const msgId = (ev.message as Message)._id;
      const lastId = lastMsg?._id;
      const isDuplicate = msgId !== undefined && lastId !== undefined
        ? msgId === lastId
        : lastMsg === ev.message;
      if (!isDuplicate) {
        // Merge tool result content from streaming message into the final message
        const toolResults = new Map<string, { resultContent: string; diff?: string; status: 'done' | 'error' }>();
        if (state.streamingMessage) {
          for (const c of state.streamingMessage.content) {
            if (c.type === 'tool_call' && c.resultContent !== undefined) {
              toolResults.set(c.id, { resultContent: c.resultContent, diff: c.diff, status: c.status === 'error' ? 'error' : 'done' });
            }
          }
        }
        if (toolResults.size > 0) {
          const merged = {
            ...ev.message,
            content: ev.message.content.map((b: { type: string; id?: string; [k: string]: unknown }) => {
              if (b.type === 'tool_call' && b.id && toolResults.has(b.id)) {
                return { ...b, ...toolResults.get(b.id) } as ContentBlock;
              }
              return b as ContentBlock;
            }),
          };
          messages = [...state.messages, merged as Message];
        } else {
          messages = [...state.messages, ev.message];
        }
      }
      streamingMessage = null; // done/turn_done 事件后清空流式消息
    } else if (ev.type === 'error') {
      error = ev.error.message;
      streamingMessage = null; // 错误后清空流式消息
    } else {
      // 更新流式消息
      streamingMessage = updateStreamingMessage(state, ev);
    }
    return { ...state, log, running, messages, error, streamingMessage, pendingPermission: TERMINALS.has(ev.type) ? null : state.pendingPermission };
  }
  // subagent events: update the subagent entry + accumulate its live events
  const idx = state.subagents.findIndex((a) => a.name === ev.agent);
  // 用户正在查看这个子代理时，即使该 agent 还没出现在列表里（首次 delegate_start 前），
  // 也要累积实时事件到 subagentMessages。
  let subagentMessages = state.subagentMessages;
  if (state.viewingSubagent === ev.agent) {
    if ((ev.type === 'done' || ev.type === 'turn_done') && ev.message.role === 'assistant') {
      subagentMessages = [...subagentMessages, ev.message];
    } else if (ev.type !== 'done' && ev.type !== 'error') {
      subagentMessages = [...subagentMessages, ev];
    }
  }
  if (idx < 0 && ev.type !== 'delegate_start') return { ...state, subagentMessages };
  let subagents: SubagentInfo[];
  if (idx < 0) {
    subagents = [...state.subagents, { name: ev.agent!, task: (ev as { task?: string }).task ?? '', status: 'running', messageCount: 0, loadedSkills: [], events: [ev] }];
  } else {
    subagents = state.subagents.map((a) => {
      if (a.name !== ev.agent) return a;
      const events = [...a.events, ev];
      switch (ev.type) {
        case 'delegate_start': return { ...a, task: (ev as { task?: string }).task ?? a.task, status: 'running', events };
        case 'done': return { ...a, status: 'done', events };
        case 'error': return { ...a, status: 'error', events };
        default: return { ...a, events };
      }
    });
  }
  return { ...state, subagents, subagentMessages };
}

export function mergeSnapshot(state: UiState, snap: SnapshotPayload): UiState {
  // Extract tool results from user messages and build a lookup map
  const toolResults = new Map<string, { content: string; diff?: string; isError?: boolean }>();
  for (const m of snap.messages) {
    if (m.role === 'user') {
      for (const c of m.content) {
        if (c.type === 'tool_result' && 'toolCallId' in c) {
          toolResults.set(c.toolCallId, { content: c.content, diff: c.diff, isError: c.isError });
        }
      }
    }
  }

  // Merge tool results into assistant messages' tool_call blocks
  const mergedMessages = snap.messages
    .filter(m => m.role !== 'user' || m.content.some(c => c.type === 'text'))
    .map(m => {
      if (m.role !== 'assistant') return m;
      const hasToolCalls = m.content.some(c => c.type === 'tool_call');
      if (!hasToolCalls || toolResults.size === 0) return m;
      return {
        ...m,
        content: m.content.map(c => {
          if (c.type === 'tool_call' && toolResults.has(c.id)) {
            const r = toolResults.get(c.id)!;
            return { ...c, resultContent: r.content, diff: r.diff, status: r.isError ? 'error' : 'done' };
          }
          return c;
        }),
      };
    });

  return {
    ...state,
    messages: mergedMessages,
    subagents: snap.subagents.map((a) => ({
      name: a.name, task: a.task,
      status: (a.status === 'done' || a.status === 'error' ? a.status : 'running') as SubagentInfo['status'],
      messageCount: a.messageCount, loadedSkills: a.loadedSkills,
      events: [],
    })),
    running: snap.running,
    log: [...snap.log],
    pendingPermission: snap.pendingPermission,
    error: snap.error ?? null,
    cwd: snap.cwd ?? '',
    streamingMessage: null,
  };
}
