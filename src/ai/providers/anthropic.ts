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
/** Anthropic requires budget_tokens >= 1024 and < max_tokens. */
const DEFAULT_THINKING_BUDGET = 4096;

export function toAnthropicBody(params: ChatParams): Record<string, unknown> {
  const systemText = params.messages
    .filter((m) => m.role === 'system')
    .flatMap((m) => m.content)
    .filter((c): c is Extract<ContentBlock, { type: 'text' }> => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

  const thinkingEnabled = params.thinking?.enabled === true;
  const thinkingBudget = params.thinking?.budgetTokens ?? DEFAULT_THINKING_BUDGET;
  // Anthropic: max_tokens must exceed the thinking budget (only matters when thinking is on).
  const maxTokens = thinkingEnabled
    ? Math.max(params.maxTokens ?? DEFAULT_MAX_TOKENS, thinkingBudget + 1)
    : (params.maxTokens ?? DEFAULT_MAX_TOKENS);

  const body: Record<string, unknown> = {
    model: params.model,
    max_tokens: maxTokens,
    stream: true,
  };
  if (systemText) body.system = systemText;
  // Anthropic forbids temperature alongside extended thinking.
  if (!thinkingEnabled && params.temperature !== undefined) body.temperature = params.temperature;
  if (thinkingEnabled) {
    body.thinking = { type: 'enabled', budget_tokens: thinkingBudget };
  }

  const cacheEnabled = params.cache?.enabled !== false;

  if (cacheEnabled && systemText) {
    body.system = [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }];
  }

  const nonSystem = params.messages.filter((m) => m.role !== 'system');
  const messages = nonSystem.map((m, i) => toAnthropicMessage(m, nonSystem[i - 1]));
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

/**
 * Convert one IR message to the Anthropic wire format. When the message is a
 * user turn carrying tool results and the immediately preceding assistant turn
 * contained thinking blocks (thinking + tool_use), the API requires the user
 * message to begin with redacted_thinking blocks carrying those signatures.
 */
function toAnthropicMessage(m: Message, previous: Message | undefined): Record<string, unknown> {
  const isToolResultTurn = m.role === 'user' && m.content.some((c) => c.type === 'tool_result');
  const thinkingSignatures = previous?.role === 'assistant'
    ? previous.content.filter((c): c is Extract<ContentBlock, { type: 'thinking' }> => c.type === 'thinking' && !!c.signature)
    : [];
  const content: Record<string, unknown>[] = [];
  if (isToolResultTurn && thinkingSignatures.length > 0) {
    for (const t of thinkingSignatures) {
      content.push({ type: 'redacted_thinking', data: t.signature });
    }
  }
  for (const block of m.content) {
    switch (block.type) {
      case 'text':
        content.push({ type: 'text', text: block.text });
        break;
      case 'thinking':
        content.push({ type: 'thinking', thinking: block.thinking });
        break;
      case 'tool_call':
        content.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input });
        break;
      case 'tool_result':
        content.push({
          type: 'tool_result',
          tool_use_id: block.toolCallId,
          content: block.content,
          ...(block.isError ? { is_error: true } : {}),
        });
        break;
    }
  }
  return { role: m.role, content };
}

export function anthropicEventsToIR(payloads: Record<string, unknown>[]): StreamEvent[] {
  const events: StreamEvent[] = [];
  const blocks: { type: string; id?: string; name?: string; text?: string; thinking?: string; signature?: string; inputJson?: string }[] = [];

  for (const p of payloads) {
    switch (p.type) {
      case 'message_start': {
        // Message-level usage arrives up front: input + any cache reads/writes.
        const usage = (p.message as { usage?: Record<string, number> } | undefined)?.usage;
        if (usage) {
          const input = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
          const output = usage.output_tokens ?? 0;
          if (input || output) events.push({ type: 'usage', inputTokens: input, outputTokens: output });
        }
        break;
      }
      case 'message_delta': {
        // Streaming output tokens are reported in the final delta.
        const usage = p.usage as { output_tokens?: number } | undefined;
        const output = usage?.output_tokens ?? 0;
        if (output) events.push({ type: 'usage', inputTokens: 0, outputTokens: output });
        break;
      }
      case 'content_block_start': {
        const cb = p.content_block as { type: string; id?: string; name?: string; text?: string; thinking?: string; signature?: string };
        blocks.push({ type: cb.type, id: cb.id, name: cb.name, text: cb.text ?? '', thinking: cb.thinking ?? '', signature: cb.signature });
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
          if (b.type === 'thinking') return { type: 'thinking', thinking: b.thinking ?? '', ...(b.signature ? { signature: b.signature } : {}) };
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
