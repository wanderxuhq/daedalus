import type { ChatParams, Message, StreamEvent, ContentBlock, ToolDefinition } from '../types.ts';
import { AiError } from '../errors.ts';
import { parseSseStream } from '../sse.ts';
import { HttpClient } from '../http.ts';

export interface AnthropicClientConfig {
  apiKey: string;
  baseURL?: string;
  model?: string;
  maxRetries?: number;
  timeoutMs?: number;
}

const DEFAULT_MODEL = 'claude-sonnet-4-5';
const DEFAULT_BASE = 'https://api.anthropic.com';
const DEFAULT_MAX_TOKENS = 8192;

export function toAnthropicBody(params: ChatParams): Record<string, unknown> {
  const systemText = params.messages
    .filter((m) => m.role === 'system')
    .flatMap((m) => m.content)
    .filter((c): c is Extract<ContentBlock, { type: 'text' }> => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

  const body: Record<string, unknown> = {
    model: params.model,
    max_tokens: params.maxTokens ?? DEFAULT_MAX_TOKENS,
    stream: true,
  };
  if (systemText) body.system = systemText;
  if (params.temperature !== undefined) body.temperature = params.temperature;

  const cacheEnabled = params.cache?.enabled !== false;

  if (cacheEnabled && systemText) {
    body.system = [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }];
  }

  const messages = params.messages.filter((m) => m.role !== 'system').map((m) => toAnthropicMessage(m));
  if (messages.length > 0 && cacheEnabled) {
    const last = messages[messages.length - 1] as Record<string, unknown>;
    last.cache_control = { type: 'ephemeral' };
  }
  body.messages = messages;

  if (params.tools?.length) {
    body.tools = params.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
      ...(cacheEnabled ? { cache_control: { type: 'ephemeral' } } : {}),
    }));
  }

  return body;
}

function toAnthropicMessage(m: Message): Record<string, unknown> {
  const content = m.content.map((block): Record<string, unknown> => {
    switch (block.type) {
      case 'text':
        return { type: 'text', text: block.text };
      case 'thinking':
        return { type: 'thinking', thinking: block.thinking };
      case 'tool_call':
        return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
      case 'tool_result':
        return {
          type: 'tool_result',
          tool_use_id: block.toolCallId,
          content: block.content,
          ...(block.isError ? { is_error: true } : {}),
        };
    }
  });
  return { role: m.role, content };
}

export function anthropicEventsToIR(payloads: Record<string, unknown>[]): StreamEvent[] {
  const events: StreamEvent[] = [];
  const blocks: { type: string; id?: string; name?: string; text?: string; thinking?: string; inputJson?: string }[] = [];

  for (const p of payloads) {
    switch (p.type) {
      case 'content_block_start': {
        const cb = p.content_block as { type: string; id?: string; name?: string; text?: string; thinking?: string };
        blocks.push({ type: cb.type, id: cb.id, name: cb.name, text: cb.text ?? '', thinking: cb.thinking ?? '' });
        if (cb.type === 'thinking') events.push({ type: 'thinking_delta', thinking: '' });
        if (cb.type === 'tool_use') events.push({ type: 'tool_call_start', id: cb.id!, name: cb.name! });
        break;
      }
      case 'content_block_delta': {
        const delta = p.delta as { type: string; text?: string; thinking?: string; partial_json?: string };
        const block = blocks[p.index as number];
        if (delta.type === 'text_delta' && delta.text) {
          if (block) block.text = (block.text ?? '') + delta.text;
          events.push({ type: 'text_delta', text: delta.text });
        } else if (delta.type === 'thinking_delta' && delta.thinking) {
          if (block) block.thinking = (block.thinking ?? '') + delta.thinking;
          events.push({ type: 'thinking_delta', thinking: delta.thinking });
        } else if (delta.type === 'input_json_delta' && delta.partial_json) {
          if (block) block.inputJson = (block.inputJson ?? '') + delta.partial_json;
          events.push({ type: 'tool_call_delta', id: block?.id ?? '', inputDelta: delta.partial_json });
        }
        break;
      }
      case 'message_stop': {
        const content: import('../types.ts').ContentBlock[] = blocks.map((b) => {
          if (b.type === 'text') return { type: 'text', text: b.text ?? '' };
          if (b.type === 'thinking') return { type: 'thinking', thinking: b.thinking ?? '' };
          if (b.type === 'tool_use') {
            let input: unknown = {};
            try { input = JSON.parse(b.inputJson ?? '{}'); } catch { input = b.inputJson ?? {}; }
            return { type: 'tool_call', id: b.id!, name: b.name!, input };
          }
          return { type: 'text', text: '' };
        });
        events.push({ type: 'done', message: { role: 'assistant', content } });
        break;
      }
      case 'error': {
        const err = p.error as { message?: string };
        events.push({ type: 'error', error: new AiError('server', err?.message ?? 'unknown error') });
        break;
      }
      default:
        break;
    }
  }
  return events;
}

export function createAnthropicClient(config: AnthropicClientConfig): import('../types.ts').AiClient {
  const baseURL = config.baseURL ?? DEFAULT_BASE;
  const model = config.model ?? DEFAULT_MODEL;
  const http = new HttpClient({
    baseURL,
    apiKey: config.apiKey,
    maxRetries: config.maxRetries,
    timeoutMs: config.timeoutMs,
  });

  return {
    async *streamChat(params: ChatParams): AsyncIterable<StreamEvent> {
      const body = toAnthropicBody({ ...params, model: params.model ?? model });
      let stream: ReadableStream<Uint8Array>;
      try {
        stream = await http.stream('/v1/messages', body, { signal: params.signal });
      } catch (e) {
        if (e instanceof AiError) {
          yield { type: 'error', error: e };
          return;
        }
        throw e;
      }
      try {
        // Blocks accumulate across payloads (content_block_delta references the
        // block opened by an earlier content_block_start), so buffer all payloads
        // and run the batch converter once at the terminal event.
        const accumulated: Record<string, unknown>[] = [];
        for await (const data of parseSseStream(stream)) {
          if (!data) continue;
          let payload: Record<string, unknown>;
          try { payload = JSON.parse(data); } catch { throw new AiError('parse', `bad SSE JSON: ${data.slice(0, 100)}`); }
          accumulated.push(payload);
          if (payload.type === 'message_stop' || payload.type === 'error') {
            for (const ev of anthropicEventsToIR(accumulated)) yield ev;
            accumulated.length = 0;
          }
        }
      } catch (e) {
        if (e instanceof AiError) { yield { type: 'error', error: e }; return; }
        throw e;
      }
    },
  };
}
