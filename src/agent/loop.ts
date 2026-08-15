import type { AiClient, StreamEvent, ToolDefinition } from '../ai/types.ts';
import type { Tool, ToolResult } from '../tools/types.ts';
import { AiError } from '../ai/errors.ts';
import type { Session } from '../core/session.ts';
import type { CoreEvent } from '../core/events.ts';
import { trimHistory } from './context.ts';

export interface RunAgentParams {
  client: AiClient;
  session: Session;
  prompt: string;
  tools: Tool[];
  cwd: string;
  askPermission: (action: string, target: string) => Promise<boolean>;
  maxIterations?: number;
  /** History budget in estimated tokens; trimming runs before each iteration. */
  maxContextTokens?: number;
}

const DEFAULT_MAX = 100;

function toCoreEvent(ev: StreamEvent): CoreEvent {
  switch (ev.type) {
    case 'text_delta': return { type: 'text_delta', text: ev.text };
    case 'thinking_delta': return { type: 'thinking_delta', thinking: ev.thinking };
    case 'tool_call_start': return { type: 'tool_call_start', id: ev.id, name: ev.name };
    case 'tool_call_delta': return { type: 'tool_call_delta', id: ev.id, inputDelta: ev.inputDelta };
    case 'done': return { type: 'done', message: ev.message };
    case 'error': return { type: 'error', error: ev.error };
  }
}

export async function runAgent(params: RunAgentParams): Promise<string> {
  const { session } = params;
  const historyLen = session.getMessages().length;
  session.addMessage({ role: 'user', content: [{ type: 'text', text: params.prompt }] });

  const toolDefs: ToolDefinition[] = params.tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));

  const maxIterations = params.maxIterations ?? DEFAULT_MAX;
  let finalText = '';

  try {
    for (let i = 0; i < maxIterations; i++) {
      // Cache-aware history trim (design §4.4): before each model request, drop
      // oldest whole turns over budget. Emit context_trim only when something changed.
      if (params.maxContextTokens !== undefined) {
        const before = session.getMessages();
        const trimmed = trimHistory(before, { maxTokens: params.maxContextTokens });
        if (trimmed !== before) {
          session.replaceMessages(trimmed);
          session.bus.emit({
            type: 'context_trim',
            dropped: before.length - trimmed.length,
            kept: trimmed.length,
          });
        }
      }
      const events: StreamEvent[] = [];
      for await (const ev of params.client.streamChat({
        messages: session.getMessages(),
        tools: toolDefs,
        cache: { enabled: true },
      })) {
        session.bus.emit(toCoreEvent(ev));
        events.push(ev);
        if (ev.type === 'error') throw ev.error;
        if (ev.type === 'done') session.addMessage(ev.message);
      }
      // Equivalent of events.findLast(...): scan backwards for the terminal 'done'.
      // findLast is an ES2023 method and this project's tsconfig targets ES2022.
      let lastAssistant: StreamEvent | undefined;
      for (let j = events.length - 1; j >= 0; j--) {
        if (events[j].type === 'done') { lastAssistant = events[j]; break; }
      }
      if (!lastAssistant || lastAssistant.type !== 'done') {
        // Adapter misbehavior: the stream ended without a terminal 'done' or
        // 'error' event. Make it loud instead of silently retrying up to
        // maxIterations.
        throw new AiError('protocol', 'stream ended without a terminal "done" or "error" event');
      }
      const msg = lastAssistant.message;
      finalText = msg.content.filter((c) => c.type === 'text').map((c) => (c.type === 'text' ? c.text : '')).join('');

      const calls = msg.content.filter((c) => c.type === 'tool_call');
      if (calls.length === 0) break;

      const results: ToolResult[] = [];
      for (const call of calls) {
        if (call.type !== 'tool_call') continue;
        const tool = params.tools.find((t) => t.name === call.name);
        let res: ToolResult;
        if (!tool) {
          res = { content: `Unknown tool: ${call.name}`, isError: true };
        } else {
          try { res = await tool.execute(call.input, { cwd: params.cwd, askPermission: params.askPermission }); }
          catch (e) { res = { content: (e as Error).message, isError: true }; }
        }
        results.push(res);
      }
      const resultBlocks = calls.map((call, idx) => {
        const r = results[idx];
        return {
          type: 'tool_result' as const,
          toolCallId: call.id,
          content: r.content,
          isError: r.isError,
        };
      });
      session.addMessage({ role: 'user', content: resultBlocks });
    }
    return finalText;
  } catch (err) {
    // Roll the failed turn back (prompt + any tool messages) so a later successful
    // run() does not persist an orphaned user prompt (final-review Finding 5).
    session.replaceMessages(session.getMessages().slice(0, historyLen));
    throw err;
  }
}
