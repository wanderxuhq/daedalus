import type { CoreEvent, SubagentInfo as SubagentInfoBase } from '../../src/core/events.ts';
import { TERMINALS } from '../../src/core/events.ts';
import type { EventEnvelope, SnapshotPayload } from './types.ts';
import type { Message } from '../../src/ai/types.ts';
import type { ContentBlock } from './types/messages.ts';
import type { StreamingMessage, StreamingContentBlock } from './types/messages.ts';

/** 比较两个 ContentBlock 数组是否内容相等（浅比较每个块的字段）。 */
function contentEquals(a: ContentBlock[], b: ContentBlock[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ca = a[i], cb = b[i];
    if (ca.type !== cb.type) return false;
    switch (ca.type) {
      case 'text':
        if (ca.text !== (cb as typeof ca).text) return false;
        break;
      case 'thinking':
        if (ca.thinking !== (cb as typeof ca).thinking || ca.signature !== (cb as typeof ca).signature) return false;
        break;
      case 'tool_call':
        // input 不参与比较：streaming 过程中 input 是字符串（delta 拼接），
        // 快照中是对象（structuredClone），两者永远不等，会导致比较误判。
        if (ca.id !== (cb as typeof ca).id || ca.name !== (cb as typeof ca).name ||
            ca.status !== (cb as typeof ca).status || ca.resultContent !== (cb as typeof ca).resultContent ||
            ca.diff !== (cb as typeof ca).diff) return false;
        break;
      case 'tool_result':
        if (ca.toolCallId !== (cb as typeof ca).toolCallId || ca.content !== (cb as typeof ca).content ||
            ca.isError !== (cb as typeof ca).isError || ca.diff !== (cb as typeof ca).diff) return false;
        break;
    }
  }
  return true;
}

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
  /** 当前正在流式输出的助手消息（实时渲染用）。引用不变，内容原地修改。 */
  streamingMessage: StreamingMessage | null;
  /** 流式消息版本号：每次原地修改 streamingMessage 后递增，触发 UI 响应式更新。 */
  streamingVersion: number;
  /** 工作目录，用于在 UI 中格式化路径。 */
  cwd: string;
}

export function initialUiState(): UiState {
  return { messages: [], subagents: [], running: false, log: [], pendingPermission: null, autoApprove: false, error: null, viewingSubagent: null, subagentMessages: [], streamingMessage: null, streamingVersion: 0, cwd: '' };
}

/** 用户点发送：本地立即回显 user 消息（不等服务端），清掉上一次的错误和流式消息。 */
export function submitPrompt(state: UiState, prompt: string): UiState {
  return {
    ...state,
    error: null,
    streamingMessage: null, // 清空流式消息
    streamingVersion: state.streamingVersion,
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

/** 更新流式消息：根据事件类型累积文本、思考和工具调用。原地修改以保持对象引用，配合 streamingVersion 触发 UI 更新。 */
function updateStreamingMessage(state: UiState, ev: CoreEvent): void {
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
      state.streamingMessage = { role: 'assistant', content };
    }
    return;
  }

  // 如果有流式消息，原地更新 content 数组（保持 streamingMessage 引用不变）
  const sm = state.streamingMessage;
  const content = sm.content;
  switch (ev.type) {
    case 'text_delta': {
      // Scan from end — last text block is almost always the last element
      let lastIdx = -1;
      for (let i = content.length - 1; i >= 0; i--) {
        if (content[i].type === 'text') { lastIdx = i; break; }
      }
      if (lastIdx >= 0) {
        const old = content[lastIdx] as Extract<StreamingContentBlock, { type: 'text' }>;
        content[lastIdx] = { ...old, text: old.text + ev.text };
      } else {
        content.push({ type: 'text', text: ev.text });
      }
      break;
    }
    case 'thinking_delta': {
      let lastIdx = -1;
      for (let i = content.length - 1; i >= 0; i--) {
        if (content[i].type === 'thinking') { lastIdx = i; break; }
      }
      if (lastIdx >= 0) {
        const old = content[lastIdx] as Extract<StreamingContentBlock, { type: 'thinking' }>;
        content[lastIdx] = { ...old, thinking: old.thinking + ev.thinking };
      } else {
        content.push({ type: 'thinking', thinking: ev.thinking });
      }
      break;
    }
    case 'tool_call_start': {
      // 去重：同 id 的 tool_call 已存在则跳过（断线重连可能重放事件）
      const exists = content.some(c => c.type === 'tool_call' && c.id === ev.id);
      if (!exists) {
        content.push({ type: 'tool_call', id: ev.id, name: ev.name, input: '', status: 'pending' });
      }
      break;
    }
    case 'tool_call_delta': {
      const toolCall = content.find(c => c.type === 'tool_call' && c.id === ev.id);
      if (toolCall && toolCall.type === 'tool_call') {
        const idx = content.indexOf(toolCall);
        content[idx] = { ...toolCall, input: toolCall.input + ev.inputDelta };
      }
      break;
    }
    case 'tool_result': {
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
    let streamingVersion = state.streamingVersion;
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
      // 更新流式消息（原地修改 content 属性）
      updateStreamingMessage(state, ev);
      // 浅拷贝 streamingMessage，强制新引用 → setState 检测到变化 → 触发组件重绘
      // 不拷贝 content 数组：原地修改的 item 已在原数组上生效，浅拷贝共享同一引用
      streamingMessage = { ...state.streamingMessage as StreamingMessage };
      streamingVersion = state.streamingVersion + 1;
    }
    return { ...state, log, running, messages, error, streamingMessage, streamingVersion, pendingPermission: TERMINALS.has(ev.type) ? null : state.pendingPermission };
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

  // 复用本地旧引用：如果快照消息和本地消息 _id 相同且内容相等，保留旧对象，
  // 避免 SolidJS 因引用变化触发无意义的重新渲染（切后台回来时 snapshot 重连导致的抖动）。
  const prevByid = new Map<number, Message>();
  for (const m of state.messages) {
    if (m._id !== undefined) prevByid.set(m._id, m);
  }
  const reconciledMessages = mergedMessages.map(m => {
    if (m._id === undefined) return m;
    const prev = prevByid.get(m._id);
    if (prev && prev.role === m.role && contentEquals(prev.content, m.content)) return prev;
    return m;
  });

  // 如果 reconciled 后的消息数组和原数组完全一样（引用没变），且其他字段也没变，
  // 直接返回旧 state，避免 SolidJS 无意义的重渲染。
  const sameMessages = reconciledMessages === state.messages
    || (reconciledMessages.length === state.messages.length
        && reconciledMessages.every((m, i) => m === state.messages[i]));
  const sameLog = snap.log.length === state.log.length;
  const sameSubagents = snap.subagents.length === state.subagents.length
    && snap.subagents.every((a, i) => {
      const cur = state.subagents[i];
      return cur.name === a.name && cur.status === a.status
        && cur.messageCount === a.messageCount && cur.task === a.task;
    });
  if (sameMessages && sameLog && sameSubagents
      && state.running === snap.running
      && state.cwd === (snap.cwd ?? '')
      && state.error === (snap.error ?? null)
      && state.pendingPermission === snap.pendingPermission) {
    return state;
  }

  return {
    ...state,
    messages: reconciledMessages,
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
    streamingVersion: 0,
  };
}
