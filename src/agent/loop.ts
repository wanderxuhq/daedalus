import type { AiClient, StreamEvent, ToolDefinition } from '../ai/types.ts';
import type { Tool, ToolContext, ToolResult } from '../tools/types.ts';
import { AiError } from '../ai/errors.ts';
import { MessageHistory } from './context.ts';

export interface RunAgentParams {
  client: AiClient;
  systemPrompt: string;
  prompt: string;
  tools: Tool[];
  cwd: string;
  askPermission: (action: string, target: string) => Promise<boolean>;
  onEvent?: (ev: StreamEvent) => void;
  maxIterations?: number;
}

const DEFAULT_MAX = 100;

export async function runAgent(params: RunAgentParams): Promise<string> {
  const history = new MessageHistory();
  history.add({ role: 'system', content: [{ type: 'text', text: params.systemPrompt }] });
  history.add({ role: 'user', content: [{ type: 'text', text: params.prompt }] });

  const toolDefs: ToolDefinition[] = params.tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));

  const maxIterations = params.maxIterations ?? DEFAULT_MAX;
  let finalText = '';

  for (let i = 0; i < maxIterations; i++) {
    const events: StreamEvent[] = [];
    for await (const ev of params.client.streamChat({
      // model omitted: client-level default (from config/flags) is applied by the adapter
      messages: history.get(),
      tools: toolDefs,
      cache: { enabled: true },
    })) {
      params.onEvent?.(ev);
      events.push(ev);
      if (ev.type === 'error') throw ev.error;
      if (ev.type === 'done') history.add(ev.message);
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
    const ctx: ToolContext = { cwd: params.cwd, askPermission: params.askPermission };
    for (const call of calls) {
      if (call.type !== 'tool_call') continue;
      const tool = params.tools.find((t) => t.name === call.name);
      let res: ToolResult;
      if (!tool) {
        res = { content: `Unknown tool: ${call.name}`, isError: true };
      } else {
        try { res = await tool.execute(call.input, ctx); }
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
    history.add({ role: 'user', content: resultBlocks });
  }
  return finalText;
}
