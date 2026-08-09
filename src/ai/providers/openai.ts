import type { ChatParams, Message, StreamEvent, ContentBlock } from '../types.ts';
import { AiError } from '../errors.ts';
import { parseSseStream } from '../sse.ts';
import { HttpClient } from '../http.ts';

export interface OpenAIClientConfig {
  apiKey: string;
  baseURL?: string;
  model?: string;
  maxRetries?: number;
  timeoutMs?: number;
}

const DEFAULT_MODEL = 'gpt-4o';
const DEFAULT_BASE = 'https://api.openai.com/v1';

export function toOpenAIBody(params: ChatParams): Record<string, unknown> {
  const messages: Record<string, unknown>[] = [];
  for (const m of params.messages) {
    if (m.role === 'system') {
      const text = m.content.filter((c): c is Extract<ContentBlock, { type: 'text' }> => c.type === 'text').map((c) => c.text).join('\n');
      messages.push({ role: 'system', content: text });
      continue;
    }
    if (m.role === 'user') {
      const textBlocks = m.content.filter((c): c is Extract<ContentBlock, { type: 'text' }> => c.type === 'text');
      const results = m.content.filter((c): c is Extract<ContentBlock, { type: 'tool_result' }> => c.type === 'tool_result');
      if (textBlocks.length) messages.push({ role: 'user', content: textBlocks.map((c) => c.text).join('\n') });
      for (const r of results) messages.push({ role: 'tool', tool_call_id: r.toolCallId, content: r.content });
      continue;
    }
    // assistant
    const text = m.content.filter((c): c is Extract<ContentBlock, { type: 'text' }> => c.type === 'text').map((c) => c.text).join('\n');
    const calls = m.content.filter((c): c is Extract<ContentBlock, { type: 'tool_call' }> => c.type === 'tool_call');
    const msg: Record<string, unknown> = { role: 'assistant', content: text || null };
    if (calls.length) {
      msg.content = null;
      msg.tool_calls = calls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: JSON.stringify(c.input) },
      }));
    }
    messages.push(msg);
  }

  const body: Record<string, unknown> = {
    model: params.model,
    messages,
    stream: true,
  };
  if (params.maxTokens !== undefined) body.max_tokens = params.maxTokens;
  if (params.temperature !== undefined) body.temperature = params.temperature;
  if (params.tools?.length) {
    body.tools = params.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));
  }
  return body;
}

export function openaiEventsToIR(payloads: Record<string, unknown>[]): StreamEvent[] {
  const events: StreamEvent[] = [];
  const textParts: string[] = [];
  const calls = new Map<number, { id: string; name: string; argParts: string[]; started: boolean }>();

  for (const p of payloads) {
    const choices = (p.choices ?? []) as Record<string, unknown>[];
    for (const choice of choices) {
      const delta = (choice.delta ?? {}) as Record<string, unknown>;
      if (typeof delta.content === 'string' && delta.content) {
        textParts.push(delta.content);
        events.push({ type: 'text_delta', text: delta.content });
      }
      const tcs = delta.tool_calls as Record<string, unknown>[] | undefined;
      if (tcs) {
        for (const tc of tcs) {
          const idx = tc.index as number;
          const fn = (tc.function ?? {}) as Record<string, unknown>;
          const fnName = typeof fn.name === 'string' ? fn.name : undefined;
          const args = typeof fn.arguments === 'string' ? fn.arguments : '';
          if (!calls.has(idx)) calls.set(idx, { id: '', name: '', argParts: [], started: false });
          const call = calls.get(idx)!;
          if (tc.id) call.id = tc.id as string;
          if (fnName) call.name = fnName;
          if (!call.started && call.id && call.name) {
            call.started = true;
            events.push({ type: 'tool_call_start', id: call.id, name: call.name });
          }
          if (args) {
            call.argParts.push(args);
            events.push({ type: 'tool_call_delta', id: call.id, inputDelta: args });
          }
        }
      }
      if (typeof choice.finish_reason === 'string' && choice.finish_reason) {
        const content: ContentBlock[] = [];
        if (textParts.length) content.push({ type: 'text', text: textParts.join('') });
        for (const call of calls.values()) {
          if (!call.id || !call.name) continue;
          let input: unknown = {};
          try { input = JSON.parse(call.argParts.join('')); } catch { input = call.argParts.join(''); }
          content.push({ type: 'tool_call', id: call.id, name: call.name, input });
        }
        events.push({ type: 'done', message: { role: 'assistant', content } });
      }
    }
    if (p.error) {
      const err = p.error as { message?: string };
      events.push({ type: 'error', error: new AiError('server', err?.message ?? 'unknown error') });
    }
  }
  return events;
}

export function createOpenAIClient(config: OpenAIClientConfig): import('../types.ts').AiClient {
  const baseURL = config.baseURL ?? DEFAULT_BASE;
  const model = config.model ?? DEFAULT_MODEL;
  const http = new HttpClient({ baseURL, apiKey: config.apiKey, maxRetries: config.maxRetries, timeoutMs: config.timeoutMs });

  return {
    async *streamChat(params: ChatParams): AsyncIterable<StreamEvent> {
      const body = toOpenAIBody({ ...params, model: params.model ?? model });
      let stream: ReadableStream<Uint8Array>;
      try {
        stream = await http.stream('/chat/completions', body, { signal: params.signal });
      } catch (e) {
        if (e instanceof AiError) { yield { type: 'error', error: e }; return; }
        throw e;
      }
      try {
        // text_delta and tool_call fragments accumulate across payloads
        // (openaiEventsToIR carries function-local state), so buffer all
        // payloads and run the batch converter once at the [DONE] sentinel.
        const accumulated: Record<string, unknown>[] = [];
        for await (const data of parseSseStream(stream)) {
          if (data === '[DONE]') {
            for (const ev of openaiEventsToIR(accumulated)) yield ev;
            break;
          }
          if (!data) continue;
          let payload: Record<string, unknown>;
          try { payload = JSON.parse(data); } catch { throw new AiError('parse', `bad SSE JSON: ${data.slice(0, 100)}`); }
          accumulated.push(payload);
          // OpenAI does NOT send [DONE] after a top-level error payload — flush
          // the accumulated batch now so prior text/tool deltas survive and the
          // error event surfaces to the caller instead of the stream silently
          // ending with zero events.
          if (payload.error) {
            for (const ev of openaiEventsToIR(accumulated)) yield ev;
            return;
          }
        }
      } catch (e) {
        if (e instanceof AiError) { yield { type: 'error', error: e }; return; }
        throw e;
      }
    },
  };
}
