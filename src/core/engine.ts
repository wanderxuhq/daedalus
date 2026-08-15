import type { AiClient } from '../ai/types.ts';
import type { Tool } from '../tools/types.ts';
import { tools as builtinTools } from '../tools/registry.ts';
import type { CoreEvent } from './events.ts';
import { Session } from './session.ts';
import type { SessionState } from './session.ts';
import { SkillRegistry } from './skills/registry.ts';
import type { SkillInfo } from './skills/types.ts';
import { createSkillTool } from './skills/skill-tool.ts';
import type { SessionMeta, SessionStore } from './session-store.ts';
import { runAgent } from '../agent/loop.ts';
import { buildSystemPrompt } from './system-prompt.ts';
import { createDelegateTool } from './delegate.ts';

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
  /** Extended thinking on by default; set false to disable. */
  thinking?: boolean;
  /** Thinking budget in tokens (Anthropic) / effort (OpenAI-compatible). */
  thinkingBudgetTokens?: number;
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
  private sessionId: string | undefined;
  private thinking: boolean;
  private thinkingBudgetTokens?: number;

  constructor(opts: EngineOptions) {
    this.session = new Session();
    this.session.start();
    this.registry = new SkillRegistry(opts.skillDirs);
    this.client = opts.client;
    this.cwd = opts.cwd;
    this.askPermission = opts.askPermission ?? (async () => false);
    this.maxIterations = opts.maxIterations;
    this.sessionStore = opts.sessionStore;
    this.maxContextTokens = opts.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS;
    this.sessionId = opts.sessionId;
    this.thinking = opts.thinking ?? true;
    this.thinkingBudgetTokens = opts.thinkingBudgetTokens;
    if (opts.initialState) {
      this.restoreState(opts.initialState);
    } else {
      this.session.addMessage({ role: 'system', content: [{ type: 'text', text: buildSystemPrompt() }] });
    }
    this.tools = [
      ...builtinTools,
      createSkillTool(this.registry, this.session),
      // Orchestrator/worker: hand self-contained tasks to a subagent that runs
      // in its own session, so its tool calls never pollute the main context.
      // availableTools excludes delegate itself — that is the recursion guard.
      createDelegateTool({
        client: opts.client,
        cwd: opts.cwd,
        askPermission: () => this.askPermission,
        availableTools: builtinTools,
        maxContextTokens: opts.maxContextTokens,
        thinking: { enabled: this.thinking, ...(this.thinkingBudgetTokens !== undefined ? { budgetTokens: this.thinkingBudgetTokens } : {}) },
      }),
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

  /** Snapshot the current session (persistence + external consumers). */
  getSessionState(): SessionState {
    return this.session.getState();
  }

  /** List persisted sessions (newest first). Empty when no store is attached. */
  async listSessions(): Promise<SessionMeta[]> {
    if (!this.sessionStore) return [];
    return this.sessionStore.list();
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
    if (!target) throw new Error('No session to resume');
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
    return { id: loaded.id, updatedAt: loaded.updatedAt, messageCount: loaded.messages.length };
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
        { role: 'system', content: [{ type: 'text', text: buildSystemPrompt() }] },
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

  async run(prompt: string): Promise<string> {
    const result = await runAgent({
      client: this.client,
      session: this.session,
      prompt,
      tools: this.tools,
      cwd: this.cwd,
      askPermission: this.askPermission,
      maxIterations: this.maxIterations,
      maxContextTokens: this.maxContextTokens,
      thinking: { enabled: this.thinking, ...(this.thinkingBudgetTokens !== undefined ? { budgetTokens: this.thinkingBudgetTokens } : {}) },
    });
    await this.persist();
    return result;
  }

  async dispose(): Promise<void> {
    await this.persist();
    this.session.dispose();
  }

  private async persist(): Promise<void> {
    if (this.sessionStore) {
      // Reuse the stable session id (resumed or first-generated) so a session is one
      // file, not one snapshot per save (design §3.3). save() returns the id used.
      this.sessionId = await this.sessionStore.save(this.getSessionState(), { id: this.sessionId, cwd: this.cwd });
    }
  }
}
