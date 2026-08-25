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
const DEFAULT_MAX_TOKENS = 16384;
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
  // Anthropic forbids temperature alongside extended thinking.
  if (!thinkingEnabled && params.temperature !== undefined) body.temperature = params.temperature;
  if (thinkingEnabled) {
    body.thinking = { type: 'enabled', budget_tokens: thinkingBudget };
  }

  const cacheEnabled = params.cache?.enabled !== false;

  if (systemText) {
    body.system = cacheEnabled
      ? [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }]
      : systemText;
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

/**
 * Stateful SSE → IR converter for Anthropic messages API. Yields events per
 * payload (like OpenAI's converter) instead of buffering everything until
 * message_stop. This prevents data loss on mid-stream interruptions.
 */
export class AnthropicSSEConverter {
  private blocks: { type: string; id?: string; name?: string; text?: string; thinking?: string; signature?: string; inputJson?: string }[] = [];
  private doneEmitted = false;

  push(payload: Record<string, unknown>): StreamEvent[] {
    const events: StreamEvent[] = [];
    switch (payload.type) {
      case 'message_start': {
        const usage = (payload.message as { usage?: Record<string, number> } | undefined)?.usage;
        if (usage) {
          const input = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
          const output = usage.output_tokens ?? 0;
          if (input || output) events.push({ type: 'usage', inputTokens: input, outputTokens: output });
        }
        break;
      }
      case 'message_delta': {
        const usage = payload.usage as { output_tokens?: number } | undefined;
        const output = usage?.output_tokens ?? 0;
        if (output) events.push({ type: 'usage', inputTokens: 0, outputTokens: output });
        break;
      }
      case 'content_block_start': {
        const cb = payload.content_block as { type: string; id?: string; name?: string; text?: string; thinking?: string; signature?: string };
        this.blocks.push({ type: cb.type, id: cb.id, name: cb.name, text: cb.text ?? '', thinking: cb.thinking ?? '', signature: cb.signature });
        if (cb.type === 'thinking') events.push({ type: 'thinking_delta', thinking: '' });
        if (cb.type === 'tool_use') events.push({ type: 'tool_call_start', id: cb.id!, name: cb.name! });
        break;
      }
      case 'content_block_delta': {
        const delta = payload.delta as { type: string; text?: string; thinking?: string; partial_json?: string };
        const block = this.blocks[payload.index as number];
        if (!block) break; // out-of-bounds index from API — skip silently
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
      case 'error': {
        const err = payload.error as { message?: string };
        events.push({ type: 'error', error: new AiError('server', err?.message ?? 'unknown error') });
        break;
      }
      default:
        break;
    }
    return events;
  }

  /** Terminal 'done' event built from accumulated block state. */
  done(): StreamEvent[] {
    if (this.doneEmitted) return [];
    this.doneEmitted = true;
    const content: import('../types.ts').ContentBlock[] = this.blocks.map((b) => {
      if (b.type === 'text') return { type: 'text', text: b.text ?? '' };
      if (b.type === 'thinking') return { type: 'thinking', thinking: b.thinking ?? '', ...(b.signature ? { signature: b.signature } : {}) };
      if (b.type === 'tool_use') {
        let input: unknown = {};
        try { input = JSON.parse(b.inputJson ?? '{}'); } catch { input = b.inputJson ?? {}; }
        return { type: 'tool_call', id: b.id ?? '', name: b.name ?? 'unknown', input };
      }
      return { type: 'text', text: '' };
    });
    return [{ type: 'done', message: { role: 'assistant', content } }];
  }
}

export function anthropicEventsToIR(payloads: Record<string, unknown>[]): StreamEvent[] {
  const converter = new AnthropicSSEConverter();
  const events: StreamEvent[] = [];
  for (const p of payloads) events.push(...converter.push(p));
  events.push(...converter.done());
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
        // Stateful converter: yields events per payload (like OpenAI) instead
        // of buffering everything until message_stop. This prevents data loss
        // on mid-stream interruptions — deltas already yielded survive.
        const converter = new AnthropicSSEConverter();
        for await (const data of parseSseStream(stream)) {
          if (!data) continue;
          let payload: Record<string, unknown>;
          try { payload = JSON.parse(data); } catch { throw new AiError('parse', `bad SSE JSON: ${data.slice(0, 100)}`); }
          for (const ev of converter.push(payload)) yield ev;
          if (payload.type === 'message_stop') {
            yield* converter.done();
            return;
          }
          if (payload.type === 'error') {
            // Yield accumulated content before error so partial response is not lost
            yield* converter.done();
            return;
          }
        }
        // Stream ended without message_stop (connection close) — synthesize done
        yield* converter.done();
      } catch (e) {
        if (e instanceof AiError) { yield { type: 'error', error: e }; return; }
        throw e;
      }
    },
  };
}
