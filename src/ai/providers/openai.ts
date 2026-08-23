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

/**
 * Map an explicit token budget to the strictest-common-denominator
 * reasoning_effort tiers. Only low/high are sent: some gateways' always-thinking
 * models (opencode zen, error [1210]) reject "medium" outright, and omitting
 * the field entirely lets each endpoint apply its own default.
 */
function effortForBudget(budgetTokens?: number): string | undefined {
  if (budgetTokens === undefined) return undefined;
  if (budgetTokens < 8192) return 'low';
  return 'high';
}

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
    // Ask for the usage object on the final stream chunk (OpenAI-style). It is
    // how the agent surfaces per-turn token counts (CC-style /cost + status).
    stream_options: { include_usage: true },
  };
  if (params.maxTokens !== undefined) body.max_tokens = params.maxTokens;
  if (params.temperature !== undefined) body.temperature = params.temperature;
  // Extended thinking on OpenAI-compatible endpoints: reasoning_effort is the
  // closest standard knob, but only with an explicit budget — an unconditional
  // default ("medium") got rejected by gateways whose models always think and
  // accept only low/high/max (error [1210]). Endpoints that ignore it answer
  // normally either way.
  const effort = params.thinking?.enabled === true ? effortForBudget(params.thinking.budgetTokens) : undefined;
  if (effort !== undefined) body.reasoning_effort = effort;
  if (params.tools?.length) {
    body.tools = params.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));
  }
  return body;
}

/**
 * Stateful SSE → IR converter for OpenAI chat completions. Text and tool-call
 * fragments arrive across many `data:` payloads; this carries the partial state
 * between payloads so deltas can be yielded live as each payload lands, and
 * builds the terminal 'done' message from the accumulated state when the stream
 * ends — whether via the `[DONE]` sentinel or, for endpoints that omit it, a
 * plain connection close.
 */
export class OpenAISSEConverter {
  private textParts: string[] = [];
  private calls = new Map<number, { id: string; name: string; argParts: string[]; started: boolean }>();
  private doneEmitted = false;

  push(payload: Record<string, unknown>): StreamEvent[] {
    const events: StreamEvent[] = [];
    const choices = (payload.choices ?? []) as Record<string, unknown>[];
    for (const choice of choices) {
      const delta = (choice.delta ?? {}) as Record<string, unknown>;
      if (typeof delta.content === 'string' && delta.content) {
        this.textParts.push(delta.content);
        events.push({ type: 'text_delta', text: delta.content });
      }
      // Reasoning models (o-series, deepseek-reasoner, most gateways) stream
      // chain-of-thought as reasoning_content. Yield it live as thinking; it is
      // intentionally NOT persisted into the done message, because the
      // OpenAI-compatible message format cannot carry it back on later turns.
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
        events.push({ type: 'thinking_delta', thinking: delta.reasoning_content });
      }
      const tcs = delta.tool_calls as Record<string, unknown>[] | undefined;
      if (tcs) {
        for (const tc of tcs) {
          const idx = tc.index as number;
          const fn = (tc.function ?? {}) as Record<string, unknown>;
          const fnName = typeof fn.name === 'string' ? fn.name : undefined;
          const args = typeof fn.arguments === 'string' ? fn.arguments : '';
          if (!this.calls.has(idx)) this.calls.set(idx, { id: '', name: '', argParts: [], started: false });
          const call = this.calls.get(idx)!;
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
    }
    if (payload.error) {
      const err = payload.error as { message?: string };
      events.push({ type: 'error', error: new AiError('server', err?.message ?? 'unknown error') });
    }
    // Final chunk carries the totals when stream_options.include_usage is set.
    const usage = payload.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
    if (usage && (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0) > 0) {
      events.push({ type: 'usage', inputTokens: usage.prompt_tokens ?? 0, outputTokens: usage.completion_tokens ?? 0 });
    }
    return events;
  }

  /** Terminal 'done' event built from the accumulated stream state.
   *
   * Always emitted — an empty completion (no text, no tool calls, e.g. a
   * content-filtered or locally-served response) is still a valid terminal
   * turn, not an adapter failure. Omitting it made runAgent throw the protocol
   * error "stream ended without a terminal done or error event" on empty
   * completions.
   */
  done(): StreamEvent[] {
    if (this.doneEmitted) return [];
    this.doneEmitted = true;
    const content: ContentBlock[] = [];
    if (this.textParts.length) content.push({ type: 'text', text: this.textParts.join('') });
    for (const call of this.calls.values()) {
      if (!call.id || !call.name) continue;
      let input: unknown = {};
      try { input = JSON.parse(call.argParts.join('')); } catch { input = call.argParts.join(''); }
      content.push({ type: 'tool_call', id: call.id, name: call.name, input });
    }
    return [{ type: 'done', message: { role: 'assistant', content } }];
  }
}

export function openaiEventsToIR(payloads: Record<string, unknown>[]): StreamEvent[] {
  const converter = new OpenAISSEConverter();
  const events: StreamEvent[] = [];
  for (const p of payloads) events.push(...converter.push(p));
  events.push(...converter.done());
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
      const converter = new OpenAISSEConverter();
      try {
        // Deltas yield live as each payload arrives; the terminal 'done' is
        // built from accumulated state at [DONE] or, for endpoints that omit
        // the sentinel (some OpenAI-compatible servers close the connection
        // instead), when the stream ends — a missing [DONE] no longer swallows
        // the whole response.
        for await (const data of parseSseStream(stream)) {
          if (data === '[DONE]') {
            yield* converter.done();
            return;
          }
          if (!data) continue;
          let payload: Record<string, unknown>;
          try { payload = JSON.parse(data); } catch { throw new AiError('parse', `bad SSE JSON: ${data.slice(0, 100)}`); }
          for (const ev of converter.push(payload)) {
            yield ev;
            // OpenAI sends a top-level error payload (no [DONE] after it) on
            // mid-stream failure — surface the error and stop; deltas already
            // yielded before it survive.
            if (ev.type === 'error') return;
          }
        }
        yield* converter.done();
      } catch (e) {
        if (e instanceof AiError) { yield { type: 'error', error: e }; return; }
        throw e;
      }
    },
  };
}
