import { promises as fs, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AiClient } from '../ai/types.ts';
import { AiError } from '../ai/errors.ts';
import type { Tool } from '../tools/types.ts';
import { createTools } from '../tools/registry.ts';
import { ShellRegistry } from '../tools/shell.ts';
import type { CoreEvent } from './events.ts';
import { Session, SessionPool } from './session.ts';
import type { SessionState } from './session.ts';
import { SkillRegistry } from './skills/registry.ts';
import type { SkillInfo } from './skills/types.ts';
import { createSkillTool } from './skills/skill-tool.ts';
import type { SessionMeta, SessionStore } from './session-store.ts';
import type { Message } from '../ai/types.ts';
import { runAgent } from '../agent/loop.ts';
import { compactHistory, summarizeTurns } from '../agent/compact.ts';
import { estimateTokens, trimHistory } from '../agent/context.ts';
import { FileLockRegistry, LockTimeoutError } from './file-lock.ts';
import { FileUndoRegistry } from './undo.ts';
import { PLAN_BLOCKED_TOOLS } from '../tools/registry.ts';
import { buildSystemPrompt, DEFAULT_MAIN_AGENT_TOOLS, SKILL_TOOL_NAME, DELEGATE_TOOL_NAME, DELEGATE_MANY_TOOL_NAME, CONSULT_TOOL_NAME, BUILTIN_TOOL_NAMES } from './system-prompt.ts';
import { createDelegateTool, createDelegateManyTool, buildSubagentPrompt, type DelegateToolOptions } from './delegate.ts';
import { createConsultTool } from './consult.ts';
import { loadMemory, MEMORY_FILE, type LoadedMemory } from './memory.ts';
import { runHook, NOTIFICATION_AFTER_MS, type HookConfig } from './hooks.ts';
import { clearSpilledOutputs } from '../tools/output.ts';

export const DEFAULT_MAX_CONTEXT_TOKENS = 100_000;

export interface EngineOptions {
  client: AiClient;
  cwd: string;
  /** Optional; the REPL installs its own via {@link setAskPermission}. Defaults to deny. */
  askPermission?: (action: string, target: string) => Promise<boolean>;
  skillDirs?: string[];
  maxIterations?: number;
  /** Seed the session from a persisted state (skips building a new system message). */
  initialState?: SessionState;
  /** Existing session id to keep writing to (resume). Default: first save() generates one. */
  sessionId?: string;
  /** When set, the engine persists the session after every run() and dispose(). */
  sessionStore?: SessionStore;
  /** History budget in estimated tokens. Default {@link DEFAULT_MAX_CONTEXT_TOKENS}. */
  maxContextTokens?: number;
  /** Session-level model override; per-request, falls back to the client default. */
  model?: string;
  /** Lifecycle hooks: PreToolUse/PostToolUse around tool calls, stop on dispose, notification on long turns. */
  hooks?: HookConfig;
  /** Extended thinking on by default; set false to disable. */
  thinking?: boolean;
  /** Thinking budget in tokens (Anthropic) / effort (OpenAI-compatible). */
  thinkingBudgetTokens?: number;
  /**
   * Tool names the MAIN agent may call directly, in display order. Default
   * {@link DEFAULT_MAIN_AGENT_TOOLS}: the author's loop (read/write/edit/Skill)
   * plus delegate and delegateMany — so bash/ls/grep/glob are removed and ALL
   * exploration and command execution is forced through subagents. Pass the
   * full builtin list (`[...BUILTIN_TOOL_NAMES, SKILL_TOOL_NAME, DELEGATE_TOOL_NAME, DELEGATE_MANY_TOOL_NAME]`)
   * to restore self-service exploration.
   */
  mainAgentTools?: string[];
  /**
   * How many delegation levels subagents may use. `1` (default): subagents
   * cannot delegate further. `2`: a subagent may spawn its own subagents. The
   * depth cap is the recursion guard.
   */
  delegateMaxDepth?: number;
  /**
   * Shared file-lock registry for the whole team (main agent + subagents).
   * Defaults to a fresh one per engine; inject for tests or multi-engine setups.
   */
  locks?: FileLockRegistry;
  /**
   * Enable automatic summarization of main conversation history for subagent context.
   * Default: true. Set to false to disable (useful for testing).
   */
  enableAutoSummary?: boolean;
}

export class DaedalusEngine {
  private session: Session;
  private registry: SkillRegistry;
  private tools: Tool[];
  private client: AiClient;
  private cwd: string;
  private askPermission: (action: string, target: string) => Promise<boolean>;
  private maxIterations?: number;
  private sessionStore?: SessionStore;
  private maxContextTokens: number;
  /** Session-level model override (`/model`); undefined = the client default. */
  private model?: string;
  /** Auto-approve tool permission prompts (`/permissions`); the REPL's askPermission reads this. */
  private autoApprove: boolean;
  /** Lifecycle hooks (PreToolUse/PostToolUse/stop/notification). */
  private hooks?: HookConfig;
  /** Plan mode: write/edit removed from every toolset; a run exits it. */
  private planMode = false;
  private sessionId: string | undefined;
  private thinking: boolean;
  private thinkingBudgetTokens?: number;
  private mainAgentTools: string[];
  /** Named subagent sessions, so `delegate {agent}` calls can keep their history across turns. */
  private sessionPool = new SessionPool();
  /** Tracks subagents currently running an agent loop, used to decide whether to restart after injecting a user message. */
  private runningSubagents = new Set<string>();
  /** Delegate configuration, reused when restarting subagent loops. */
  private delegateOptions: DelegateToolOptions | null = null;
  private usageStats = { inputTokens: 0, outputTokens: 0 };
  /** Team-wide file locks (main agent + subagents share one registry). */
  private locks: FileLockRegistry;
  /** Per-agent undo stacks for file mutations (`/undo`). */
  private undo: FileUndoRegistry;
  /** Per-agent persistent bash shells (cwd/env survive across tool calls). */
  private shells: ShellRegistry;
  /** Durable project memory (DAEDALUS.md) read once at construction. */
  private memory: LoadedMemory = { sources: [], text: '' };

  constructor(opts: EngineOptions) {
    this.session = new Session();
    this.session.start();
    this.registry = new SkillRegistry(opts.skillDirs);
    this.client = opts.client;
    this.cwd = opts.cwd;
    this.askPermission = opts.askPermission ?? (async () => false);
    this.locks = opts.locks ?? new FileLockRegistry();
    this.undo = new FileUndoRegistry();
    this.maxIterations = opts.maxIterations;
    this.sessionStore = opts.sessionStore;
    this.maxContextTokens = opts.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS;
    this.model = opts.model;
    this.autoApprove = false;
    this.hooks = opts.hooks;
    this.sessionId = opts.sessionId;
    this.thinking = opts.thinking ?? true;
    this.thinkingBudgetTokens = opts.thinkingBudgetTokens;
    // Layering: the main agent gets only its own tools (default: author's loop
    // + delegate). Everything else — bash/ls/grep/glob — exists ONLY in the
    // subagent's toolset, so exploration and command execution are forced
    // through delegate. Pass mainAgentTools to customize.
    this.mainAgentTools = opts.mainAgentTools ?? [...DEFAULT_MAIN_AGENT_TOOLS];
    // Read DAEDALUS.md once (user-level + nearest project file). The text is a
    // fixed part of every system prompt for the session's lifetime, so prompt
    // cache prefixes stay byte-stable across turns. Consult clones are NOT given
    // memory: their history is a byte-identical copy of the source session, and
    // adding a section would break that prefix.
    this.memory = loadMemory(opts.cwd);
    // One shell per agent (main + each named subagent), shared by all tools;
    // bash dispatches on ctx.agent. Cleared on dispose.
    this.shells = new ShellRegistry(opts.cwd);
    const builtinTools = createTools(this.shells);
    const byName = new Map(builtinTools.map((t) => [t.name, t]));
    const mainBuiltin = this.mainAgentTools.filter((n) => byName.has(n)).map((n) => byName.get(n)!);
    const hasSkill = this.mainAgentTools.includes(SKILL_TOOL_NAME);
    const hasDelegate = this.mainAgentTools.includes(DELEGATE_TOOL_NAME);
    const hasDelegateMany = this.mainAgentTools.includes(DELEGATE_MANY_TOOL_NAME);
    const hasConsult = this.mainAgentTools.includes(CONSULT_TOOL_NAME);
    // The system prompt advertises tools in the same order the agent holds them
    // (delegate first, per DEFAULT_MAIN_AGENT_TOOLS), so the model sees the
    // delegation channel as its primary tool.
    const systemTools = [...this.mainAgentTools];
    if (opts.initialState) {
      this.restoreState(opts.initialState);
    } else {
      this.session.addMessage({ role: 'system', content: [{ type: 'text', text: buildSystemPrompt({ tools: systemTools, memory: this.memory.text }) }] });
    }
    // Track token usage across runs (REPL `/cost`). Subagent usage events are
    // forwarded onto this bus by the delegate tools (onEvent), so /cost covers
    // the whole turn including delegated work.
    this.session.bus.subscribe((ev) => {
      if (ev.type === 'usage') {
        this.usageStats.inputTokens += ev.inputTokens;
        this.usageStats.outputTokens += ev.outputTokens;
      }
    });
    // Shared config for both delegation tools. onEvent forwards subagent
    // progress onto the main session bus (UI visibility) — it never enters the
    // main session's MESSAGE history, so context isolation is preserved.
    const delegateOptions = {
      client: opts.client,
      cwd: opts.cwd,
      askPermission: () => this.askPermission,
      // Subagents get the FULL builtin set (bash/read/write/edit/ls/grep/glob).
      // Delegation depth is capped by delegateMaxDepth (default 1 = subagents
      // cannot delegate further); the cap, not tool absence, is the recursion guard.
      availableTools: builtinTools,
      // The same DAEDALUS.md memory the main agent sees goes into each subagent's
      // system prompt, so workers follow the project's conventions too.
      memory: this.memory.text,
      maxContextTokens: opts.maxContextTokens,
      thinking: { enabled: this.thinking, ...(this.thinkingBudgetTokens !== undefined ? { budgetTokens: this.thinkingBudgetTokens } : {}) },
      maxDepth: opts.delegateMaxDepth,
      sessions: this.sessionPool,
      locks: this.locks,
      undo: this.undo,
      planMode: () => this.planMode,
      onEvent: (ev: CoreEvent) => this.session.bus.emit(ev),
      // Track subagent lifecycle so injectSubagentMessage doesn't duplicate loops
      onSubagentStart: (name: string) => { this.runningSubagents.add(name); },
      onSubagentEnd: (name: string) => { this.runningSubagents.delete(name); },
      // Provide access to main conversation history for context summarization
      getMainHistory: () => this.session.getMessages(),
      // Enable automatic summarization of main history for subagent context
      enableAutoSummary: opts.enableAutoSummary !== false,
      // Shared summary cache: avoids redundant LLM calls when main conversation
      // hasn't changed between consecutive delegate calls.
      summaryCache: { key: '', summary: '' },
    };
    // Store delegate options for restarting subagents when user sends messages.
    this.delegateOptions = delegateOptions;
    this.tools = [
      // delegate first: the main agent should reach for a subagent before its own tools.
      ...(hasDelegate ? [createDelegateTool(delegateOptions)] : []),
      ...(hasDelegateMany ? [createDelegateManyTool(delegateOptions)] : []),
      ...(hasConsult ? [createConsultTool({
        client: opts.client,
        cwd: opts.cwd,
        askPermission: () => this.askPermission,
        // The clone may use the full builtin set, but NEVER delegate — no recursion.
        availableTools: builtinTools,
        maxContextTokens: opts.maxContextTokens,
        ...(this.model !== undefined ? { model: this.model } : {}),
        thinking: { enabled: this.thinking, ...(this.thinkingBudgetTokens !== undefined ? { budgetTokens: this.thinkingBudgetTokens } : {}) },
        locks: this.locks,
        undo: this.undo,
        planMode: () => this.planMode,
        // has() before get(): consulting an unknown name must error, not create
        // an empty pooled session.
        getHistory: (name: string) => (this.sessionPool.has(name) ? this.sessionPool.get(name).getMessages() : undefined),
        onEvent: (ev: CoreEvent) => this.session.bus.emit(ev),
      })] : []),
      ...mainBuiltin,
      ...(hasSkill ? [createSkillTool(this.registry, this.session)] : []),
    ];
  }

  subscribe(handler: (ev: CoreEvent) => void): () => void {
    return this.session.bus.subscribe(handler);
  }

  /** Replace the permission handler (the REPL installs its own here). */
  setAskPermission(ask: (action: string, target: string) => Promise<boolean>): void {
    this.askPermission = ask;
  }

  get skills(): SkillInfo[] {
    return this.registry.list();
  }

  /** Paths the loaded DAEDALUS.md memory came from (user-level first, project last). */
  get memorySources(): string[] {
    return this.memory.sources;
  }

  /** Snapshot the current session (persistence + external consumers). */
  getSessionState(): SessionState {
    return this.session.getState();
  }

  /** List persisted sessions (newest first). Empty when no store is attached. */
  async listSessions(): Promise<SessionMeta[]> {
    if (!this.sessionStore) return [];
    return this.sessionStore.list();
  }

  /** Snapshot of every live subagent (named sessions): name, message count, loaded skills. */
  listSubagents(): Array<{ name: string; messageCount: number; loadedSkills: string[] }> {
    return this.sessionPool.entries().map(({ key, session }) => ({
      name: key,
      messageCount: session.getMessages().length,
      loadedSkills: session.getLoadedSkills(),
    }));
  }

  /** Read one subagent's full message history (live in memory; never persisted). */
  getSubagentMessages(name: string): Message[] {
    // has() before get(): inspecting an unknown subagent must not materialize
    // an empty pooled session (which would then show up in /agents and emit a
    // session_start for a session that never ran).
    return this.sessionPool.has(name) ? this.sessionPool.get(name).getMessages() : [];
  }

  /** Dispose a named subagent and drop its history; the next call with that name starts fresh. */
  closeSubagent(name: string): void {
    this.sessionPool.reset(name);
  }

  /**
   * Inject a user message into a subagent's session. The message is added to
   * the pending queue and will be processed in the next iteration of the
   * subagent's agent loop. If the subagent is not currently running, a new
   * agent loop is started automatically.
   */
  injectSubagentMessage(name: string, prompt: string): void {
    const session = this.sessionPool.get(name);
    session.addPendingMessage({
      role: 'user',
      content: [{ type: 'text', text: prompt }],
    });
    // If the subagent is not running, start a new agent loop to process the message.
    if (!this.runningSubagents.has(name)) {
      // Create a descriptive task label for the frontend
      const truncated = prompt.length > 40 ? prompt.slice(0, 40) + '...' : prompt;
      const taskDesc = `Continue: ${truncated}`;
      this.startSubagentLoop(name, taskDesc);
    }
  }

  /**
   * Start the agent loop for a subagent. The loop will process pending messages
   * and run until the subagent completes its task or is interrupted.
   */
  private startSubagentLoop(name: string, task?: string): void {
    if (!this.delegateOptions) {
      throw new Error('Delegate options not initialized');
    }
    const session = this.sessionPool.get(name);
    // If the session is empty, it needs a system prompt (this shouldn't happen
    // for user-initiated messages, but handle defensively). Use the stored prompt
    // from the original delegate call to ensure consistency (tools, json mode, etc.).
    if (session.getMessages().length === 0) {
      const promptText = session.systemPromptText
        ?? buildSubagentPrompt({ memory: this.delegateOptions.memory });
      session.addMessage({
        role: 'system',
        content: [{ type: 'text', text: promptText }],
      });
    }
    this.runningSubagents.add(name);
    const opts = this.delegateOptions;
    // Emit delegate_start event so the frontend knows the subagent is running again.
    // This is important for restarting subagents after they complete.
    this.session.bus.emit({ type: 'delegate_start', agent: name, task: task ?? 'Handle user message' });
    // Subscribe to subagent's session bus and forward events to main session bus.
    // Without this, events (text_delta, done, etc.) are lost and the frontend
    // never receives the subagent's response.
    const unsub = session.bus.subscribe((ev) => {
      this.session.bus.emit({ ...ev, agent: name } as CoreEvent);
    });
    // Run the agent loop in the background. It will drain pending messages
    // at the start of each iteration.
    runAgent({
      client: opts.client,
      session,
      prompt: '', // Empty prompt: messages are already in the session (pending queue)
      tools: opts.availableTools,
      cwd: opts.cwd,
      askPermission: opts.askPermission(),
      maxContextTokens: opts.maxContextTokens,
      ...(opts.thinking ? { thinking: opts.thinking } : {}),
      locks: opts.locks,
      undo: opts.undo,
      agent: name,
    }).then(() => {
      unsub();
      this.runningSubagents.delete(name);
      // Defer the restart check so that a concurrent injectSubagentMessage
      // completes before we decide whether to restart. Without this, the
      // delete + hasPendingMessages window allows a race where two loops
      // start for the same session.
      queueMicrotask(() => {
        if (session.hasPendingMessages()) {
          this.startSubagentLoop(name);
        }
      });
      // Note: the loop's session bus already emitted the 'done' event (forwarded
      // to the main bus via the unsub subscriber above). We must NOT emit a second
      // 'done' here — it would create duplicate events in the UI.
    }).catch((err) => {
      unsub();
      this.runningSubagents.delete(name);
      queueMicrotask(() => {
        if (session.hasPendingMessages()) {
          this.startSubagentLoop(name);
        } else {
          // Emit error event so the UI knows the subagent failed
          const aiErr = err instanceof AiError ? err : new AiError('server', (err as Error).message);
          this.session.bus.emit({ type: 'error', agent: name, error: aiErr });
        }
      });
    });
  }

  /**
   * Switch the live session to a persisted one (REPL `/resume`). The current
   * session is persisted first so switching never drops unsaved history; then the
   * target's messages and loaded skills replace the in-memory state and later
   * saves keep writing to the resumed file. Without an id, the most recent
   * session is used. Returns the resumed session's metadata.
   */
  async resume(id?: string): Promise<SessionMeta> {
    if (!this.sessionStore) throw new Error('Sessions are not persisted (no session store attached)');
    const target = id ? { id } : await this.sessionStore.latest();
    if (!target) {
      throw new Error(
        `No sessions to resume — run a conversation first. Sessions are saved to ${this.sessionStore.dir} after each run; /sessions lists them.`,
      );
    }
    // Persist the live session under its current id so nothing is lost on switch.
    // Skip when there is nothing to persist yet — a fresh REPL that never ran a
    // turn (only the system message) should not litter an empty session file.
    const live = this.getSessionState();
    if (this.sessionId || live.messages.length > 1) {
      this.sessionId = await this.sessionStore.save(live, { id: this.sessionId, cwd: this.cwd });
    }
    const loaded = await this.sessionStore.load(target.id);
    this.restoreState({ messages: loaded.messages, loadedSkills: loaded.loadedSkills });
    this.sessionId = loaded.id; // continue writing to the resumed session's file
    return {
      id: loaded.id,
      updatedAt: loaded.updatedAt,
      title: loaded.title ?? 'Untitled session',
      messageCount: loaded.messages.length,
    };
  }

  /**
   * Replace the in-memory state from a persisted snapshot (constructor seed and
   * REPL `/resume`). Reuses the persisted system message verbatim so the cache
   * prefix stays byte-identical across a resume (design §3.2); a defensive system
   * message is PREPENDED only when the restored history lacks one (old/corrupt
   * state) so system stays at index 0.
   */
  private restoreState(state: SessionState): void {
    this.session.replaceMessages(state.messages);
    this.session.restoreLoadedSkills(state.loadedSkills);
    if (!state.messages.some((m) => m.role === 'system')) {
      this.session.replaceMessages([
        { role: 'system', content: [{ type: 'text', text: buildSystemPrompt({ tools: this.mainAgentTools }) }] },
        ...state.messages,
      ]);
    }
  }

  async loadSkill(name: string): Promise<SkillInfo> {
    const skill = this.registry.get(name);
    if (!skill) throw new Error(`Unknown skill: ${name}`);
    if (!this.session.isSkillLoaded(name)) {
      this.session.markSkillLoaded(name);
      this.session.addMessage({
        role: 'user',
        content: [{ type: 'text', text: `[Skill: ${name}]\n\n${skill.body}` }],
      });
    }
    return skill;
  }

  async run(prompt: string, opts: { signal?: AbortSignal } = {}): Promise<string> {
    const startedAt = Date.now();
    // Plan mode removes write/edit from the MAIN agent's toolset for this run
    // (subagents drop them via the delegate tools' planMode flag). One-shot:
    // a completed run exits plan mode automatically.
    const tools = this.planMode ? this.tools.filter((t) => !PLAN_BLOCKED_TOOLS.has(t.name)) : this.tools;
    const result = await runAgent({
      client: this.client,
      session: this.session,
      prompt,
      tools,
      cwd: this.cwd,
      askPermission: this.askPermission,
      maxIterations: this.maxIterations,
      maxContextTokens: this.maxContextTokens,
      thinking: { enabled: this.thinking, ...(this.thinkingBudgetTokens !== undefined ? { budgetTokens: this.thinkingBudgetTokens } : {}) },
      locks: this.locks,
      undo: this.undo,
      ...(this.model !== undefined ? { model: this.model } : {}),
      ...(this.hooks ? { hooks: this.hooks } : {}),
      agent: 'main',
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    await this.persist();
    // Plan mode is one-shot: a run that completed is either the plan itself or
    // the follow-up after approval — either way the next turn starts normal.
    if (this.planMode) this.planMode = false;
    // Notification hook: a long turn finishing is the classic "come look" moment.
    // Runs after persist so the session file is already current when it fires.
    if (this.hooks?.notification && Date.now() - startedAt >= NOTIFICATION_AFTER_MS) {
      try {
        await runHook(this.hooks.notification, { elapsedMs: Date.now() - startedAt, result });
      } catch { /* advisory */ }
    }
    return result;
  }

  /** Whether write/edit are currently removed (plan mode). */
  getPlanMode(): boolean {
    return this.planMode;
  }

  /** Enter (`true`) or leave (`false`) plan mode (`/plan`). */
  setPlanMode(enabled: boolean): void {
    this.planMode = enabled;
  }

  /** Current session-level model override, or undefined for the client default. */
  getModel(): string | undefined {
    return this.model;
  }

  /** Set the session-level model override (`/model <name>`); per-request, not persisted. */
  setModel(model: string): void {
    this.model = model;
  }

  /** Whether tool permission prompts are auto-approved (`/permissions`). */
  getAutoApprove(): boolean {
    return this.autoApprove;
  }

  /** Turn auto-approve on/off; the REPL's askPermission reads this live. */
  setAutoApprove(enabled: boolean): void {
    this.autoApprove = enabled;
  }

  /**
   * Drop everything but the system prompt (`/clear`): removes conversation
   * history and loaded skills, so the next run starts fresh while the cache
   * prefix (system message) stays byte-identical. Returns the number of
   * messages removed.
   */
  clearConversation(): number {
    const all = this.session.getMessages();
    const system = all.filter((m) => m.role === 'system');
    const dropped = all.length - system.length;
    this.session.replaceMessages(system);
    this.session.restoreLoadedSkills([]);
    return dropped;
  }

  /**
   * Manually trigger context management (`/compact`): summarize the oldest
   * whole turns with the model, falling back to a hard trim when the summary
   * fails or nothing is compactable. Mirrors the per-iteration pass in the
   * agent loop, but runs on demand.
   */
  async compactNow(): Promise<{ status: 'compacted' | 'trimmed' | 'idle'; dropped: number; kept: number }> {
    const before = this.session.getMessages();
    try {
      const compacted = await compactHistory(before, {
        maxTokens: this.maxContextTokens,
        summarize: (turns) => summarizeTurns(this.client, turns),
      });
      if (compacted) {
        this.session.replaceMessages(compacted.messages);
        this.session.bus.emit({ type: 'context_compact', dropped: compacted.dropped, kept: compacted.messages.length });
        return { status: 'compacted', dropped: compacted.dropped, kept: compacted.messages.length };
      }
    } catch {
      // Summarizer failed (network, provider, …): fall through to a hard trim.
    }
    const trimmed = trimHistory(this.session.getMessages(), { maxTokens: this.maxContextTokens });
    if (trimmed !== this.session.getMessages()) {
      this.session.replaceMessages(trimmed);
      this.session.bus.emit({
        type: 'context_trim',
        dropped: before.length - trimmed.length,
        kept: trimmed.length,
      });
      return { status: 'trimmed', dropped: before.length - trimmed.length, kept: trimmed.length };
    }
    return { status: 'idle', dropped: 0, kept: before.length };
  }

  /** Estimated token usage of the live history vs the context budget (statusline). */
  contextUsage(): { tokens: number; maxTokens: number } {
    return { tokens: estimateTokens(this.session.getMessages()), maxTokens: this.maxContextTokens };
  }

  /** Starter DAEDALUS.md template for `/init` — the project memory file. */
  private static readonly MEMORY_TEMPLATE = [
    '# DAEDALUS.md',
    '',
    'Durable project memory for the Daedalus agent — the project-conventions file.',
    'It is loaded into the system prompt of every turn (the nearest DAEDALUS.md walking',
    'up from the working directory wins; `~/.daedalus/DAEDALUS.md` is the user-level fallback).',
    '',
    '## Conventions',
    '',
    '- Record what the agent must ALWAYS do in this repo: build/test commands, layout, style, do/don\'t.',
    '- Keep it short and factual — it is injected into every prompt and costs tokens.',
    '- Update it when the team learns something durable (a gotcha, a workflow, a command).',
    '',
    '## Build / test',
    '',
    '- `npm run build` — typecheck',
    '- `npm test` — full suite',
  ].join('\n');

  /**
   * Create `<cwd>/DAEDALUS.md` if it does not exist (`/init`). Never
   * overwrites: an existing memory file is reported as `created: false`.
   */
  async initMemory(): Promise<{ path: string; created: boolean }> {
    const path = join(this.cwd, MEMORY_FILE);
    if (existsSync(path)) return { path, created: false };
    await fs.writeFile(path, `${DaedalusEngine.MEMORY_TEMPLATE}\n`, 'utf8');
    return { path, created: true };
  }

  /**
   * Restore the main agent's most recent file mutation (REPL `/undo`). The
   * edit/write tools snapshot pre-mutation content in memory; undoing writes it
   * back (or deletes a file the mutation created). Returns what was restored,
   * or undefined when there is nothing to undo. A lock conflict surfaces as a
   * non-restored result with the reason.
   */
  async undoLastEdit(): Promise<{ path: string; restored: boolean; message?: string } | undefined> {
    try {
      const entry = await this.undo.undo('main', this.locks);
      if (!entry) return undefined;
      return { path: entry.path, restored: true };
    } catch (e) {
      if (e instanceof LockTimeoutError) {
        return { path: '<unknown>', restored: false, message: (e as Error).message };
      }
      throw e;
    }
  }

  /** Cumulative input/output tokens across all runs of this session (REPL `/cost`). */
  usage(): { inputTokens: number; outputTokens: number } {
    return { ...this.usageStats };
  }

  async dispose(): Promise<void> {
    await this.persist();
    // Stop hook: the session's last chance to run project automation before the
    // engine shuts down. Advisory — a failing hook never blocks disposal.
    if (this.hooks?.stop) {
      try {
        await runHook(this.hooks.stop, {});
      } catch { /* advisory */ }
    }
    this.session.dispose();
    this.sessionPool.clear();
    this.shells.clear();
    this.locks.clear();
    this.undo.clear();
    // Tool-output spill files (truncateResult) are dead once the session is
    // gone; drop them so a long-running process's temp dir does not accumulate.
    clearSpilledOutputs();
  }

  private async persist(): Promise<void> {
    if (this.sessionStore) {
      // Reuse the stable session id (resumed or first-generated) so a session is one
      // file, not one snapshot per save (design §3.3). save() returns the id used.
      // Use clone=false: save() only serializes to JSON, no mutation risk.
      this.sessionId = await this.sessionStore.save(this.session.getState(false), { id: this.sessionId, cwd: this.cwd });
    }
  }
}
