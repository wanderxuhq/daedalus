import type { AiClient, Message, StreamEvent, ToolDefinition, ThinkingParams } from '../ai/types.ts';
import type { Tool, ToolResult } from '../tools/types.ts';
import { AiError } from '../ai/errors.ts';
import type { Session } from '../core/session.ts';
import type { CoreEvent } from '../core/events.ts';
import type { FileLockRegistry } from '../core/file-lock.ts';
import type { FileUndoRegistry } from '../core/undo.ts';
import { matchesHook, runHook, runPreToolUseHooks, type HookConfig } from '../core/hooks.ts';
import { trimHistory } from './context.ts';
import { compactHistory, summarizeTurns } from './compact.ts';

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
  /** Extended thinking request forwarded to the model on every turn. */
  thinking?: ThinkingParams;
  /** Session-level model override; per-request, falls back to the client default. */
  model?: string;
  /** Abort the in-flight model request (Ctrl+C interrupt). */
  signal?: AbortSignal;
  /** Shared file locks so concurrent agents don't clobber each other's files. */
  locks?: FileLockRegistry;
  /** Per-agent undo registry: edit/write snapshot pre-mutation content here. */
  undo?: FileUndoRegistry;
  /** Lifecycle hooks (PreToolUse / PostToolUse), run around tool calls. */
  hooks?: HookConfig;
  /** Identity label for lock holders ('main', a subagent name, …). */
  agent?: string;
}

const DEFAULT_MAX = 100;

/**
 * True when an assistant message carries anything the providers can round-trip.
 * Reasoning models can end a turn with no text and no tool calls (only
 * reasoning_content streamed, which adapters do not persist); such a message
 * must not enter the session — the next request would re-send `content: []`
 * and Anthropic-compatible endpoints reject it ("content or tool_calls must
 * be set"). An empty-text-only message serializes to `content: null`, the same
 * rejection.
 */
function hasPersistableContent(m: Message): boolean {
  return m.content.some((c) =>
    c.type === 'tool_call' ||
    (c.type === 'text' && c.text.length > 0) ||
    c.type === 'thinking'
  );
}

function toCoreEvent(ev: StreamEvent): CoreEvent {
  switch (ev.type) {
    case 'text_delta': return { type: 'text_delta', text: ev.text };
    case 'thinking_delta': return { type: 'thinking_delta', thinking: ev.thinking };
    case 'tool_call_start': return { type: 'tool_call_start', id: ev.id, name: ev.name };
    case 'tool_call_delta': return { type: 'tool_call_delta', id: ev.id, inputDelta: ev.inputDelta };
    case 'usage': return { type: 'usage', inputTokens: ev.inputTokens, outputTokens: ev.outputTokens };
    case 'done': return { type: 'done', message: ev.message };
    case 'error': return { type: 'error', error: ev.error };
  }
}

export async function runAgent(params: RunAgentParams): Promise<string> {
  const { session } = params;
  // Reference-set of the messages that existed BEFORE this run. The rollback in
  // the catch below removes exactly what this run added by identity — NOT by a
  // count slice: an auto-compact mid-run can replace the history array (old
  // turns collapse into one merged summary), so the pre-run message count is
  // stale and `slice(0, historyLen)` would silently keep the orphaned prompt.
  // Message objects keep their identity across replaceMessages, so walking to
  // the first non-pre-run message is always correct (and, when compaction
  // merged the prompt into a summary, truncates before it — leaving a valid,
  // provider-acceptable state).
  const preRun = new Set<Message>(session.getMessages());
  // An empty prompt means the caller pre-built the full history (consult's
  // read-only clone); skip injection so no empty user message is created.
  if (params.prompt) {
    session.addMessage({ role: 'user', content: [{ type: 'text', text: params.prompt }] });
  }

  const toolDefs: ToolDefinition[] = params.tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));

  const maxIterations = params.maxIterations ?? DEFAULT_MAX;
  let finalText = '';

  try {
    for (let i = 0; i < maxIterations; i++) {
      // Check for pending user messages injected by the user (e.g., via web UI).
      // These are processed in the next iteration of the loop, similar to how
      // a programming loop picks up new input in the next cycle.
      session.drainPendingMessages();

      // Cache-aware context management (design §4.4): before each model request,
      // fit the history to the budget — CC-style: summarize the oldest turns with
      // the model (auto-compact) so nothing is lost; hard-trim only as a fallback
      // when the summary call fails or nothing is compactable. Emit an event only
      // when something actually changed.
      if (params.maxContextTokens !== undefined) {
        const before = session.getMessages();
        let changed = false;
        try {
          const compacted = await compactHistory(before, {
            maxTokens: params.maxContextTokens,
            summarize: (turns) => summarizeTurns(params.client, turns),
          });
          if (compacted) {
            session.replaceMessages(compacted.messages);
            session.bus.emit({ type: 'context_compact', dropped: compacted.dropped, kept: compacted.messages.length });
            changed = true;
          }
        } catch {
          // Summarizer failed (network, provider, …): fall through to a hard trim
          // rather than failing the whole turn.
        }
        if (!changed) {
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
      }
      const events: StreamEvent[] = [];
      for await (const ev of params.client.streamChat({
        messages: session.getMessages(),
        tools: toolDefs,
        cache: { enabled: true },
        ...(params.thinking ? { thinking: params.thinking } : {}),
        ...(params.model !== undefined ? { model: params.model } : {}),
        ...(params.signal ? { signal: params.signal } : {}),
      })) {
        session.bus.emit(toCoreEvent(ev));
        events.push(ev);
        if (ev.type === 'error') throw ev.error;
        if (ev.type === 'done' && hasPersistableContent(ev.message)) session.addMessage(ev.message);
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

      // Execute the batch of tool calls in parallel: when a model emits several
      // tool_calls in one message it is asserting they are independent (parallel
      // tool use is a first-class API feature). Results are written back by call
      // index so the model-facing result blocks keep the SAME order as the calls
      // (providers pair tool_result to tool_call by id, but order-preserving is
      // safest). File locks make concurrent writes to the same path safe — they
      // serialize on the lock instead of clobbering. Each call still gets its own
      // permission prompt; an error in one call degrades to its own error result
      // and never aborts the siblings.
      const results: ToolResult[] = new Array(calls.length);
      await Promise.all(calls.map(async (call, idx) => {
        const tool = params.tools.find((t) => t.name === call.name);
        let res: ToolResult;
        if (!tool) {
          res = { content: `Unknown tool: ${call.name}`, isError: true };
        } else {
          // PreToolUse hooks may deny the call or append model context. A hook
          // failure is advisory (ignored); only an explicit deny blocks.
          let denied: string | undefined;
          let extraContext = '';
          if (params.hooks?.preToolUse?.length) {
            try {
              const decision = await runPreToolUseHooks(params.hooks.preToolUse, call.name, call.input);
              if (decision.denied) denied = decision.reason ?? 'denied by hook';
              else extraContext = decision.additionalContext ?? '';
            } catch { /* hook broke — never break the tool */ }
          }
          if (denied) {
            res = { content: `Hook denied ${call.name}${denied ? `: ${denied}` : ''}`, isError: true };
          } else {
            try {
              res = await tool.execute(call.input, {
                cwd: params.cwd,
                askPermission: params.askPermission,
                ...(params.signal ? { signal: params.signal } : {}),
                ...(params.locks ? { locks: params.locks } : {}),
                ...(params.undo ? { undo: params.undo } : {}),
                ...(params.agent !== undefined ? { agent: params.agent } : {}),
              });
              // PreToolUse additionalContext rides along in the result the model
              // sees (the UI card renders content, so it is visible there too).
              if (extraContext) res = { ...res, content: `${res.content}\n\n[hook context]\n${extraContext}` };
            }
            catch (e) { res = { content: (e as Error).message, isError: true }; }
          }
        }
        // PostToolUse hooks observe the completed call (input + response);
        // they cannot modify anything. Failures are advisory and ignored.
        if (params.hooks?.postToolUse?.length) {
          for (const rule of params.hooks.postToolUse) {
            if (matchesHook(rule, call.name, call.input)) {
              try {
                await runHook(rule.command, { toolName: call.name, toolInput: call.input, toolResponse: res }, rule.timeoutMs);
              } catch { /* hook broke — ignore */ }
            }
          }
        }
        results[idx] = res;
        // Surface the result to the UI (render.ts) as well as to the model, so a
        // tool card with its output can be drawn — like Claude Code, not raw JSON.
        // A file-mutation diff rides along for the UI card only; the model's
        // result block (below) carries content alone.
        session.bus.emit({
          type: 'tool_result',
          id: call.id,
          name: call.name,
          input: call.input,
          content: res.content,
          isError: res.isError,
          ...(res.diff !== undefined ? { diff: res.diff } : {}),
        });
      }));
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
    const keep: Message[] = [];
    for (const m of session.getMessages()) {
      if (!preRun.has(m)) break; // the first message this run added — truncate here
      keep.push(m);
    }
    session.replaceMessages(keep);
    throw err;
  }
}
