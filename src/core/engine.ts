import type { AiClient } from '../ai/types.ts';
import type { Tool } from '../tools/types.ts';
import { tools as builtinTools } from '../tools/registry.ts';
import type { CoreEvent } from './events.ts';
import { Session } from './session.ts';
import type { SessionState } from './session.ts';
import { SkillRegistry } from './skills/registry.ts';
import type { SkillInfo } from './skills/types.ts';
import { createSkillTool } from './skills/skill-tool.ts';
import type { SessionStore } from './session-store.ts';
import { runAgent } from '../agent/loop.ts';
import { buildSystemPrompt } from './system-prompt.ts';

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
    if (opts.initialState) {
      // Restore verbatim: the persisted system message is reused as-is so the cache
      // prefix stays byte-identical across a resume (design §3.2). Defensive re-add
      // only when the restored history lacks a system message (old/corrupt state).
      this.session.replaceMessages(opts.initialState.messages);
      this.session.restoreLoadedSkills(opts.initialState.loadedSkills);
      if (!opts.initialState.messages.some((m) => m.role === 'system')) {
        this.session.replaceMessages([
          { role: 'system', content: [{ type: 'text', text: buildSystemPrompt() }] },
          ...opts.initialState.messages,
        ]);
      }
    } else {
      this.session.addMessage({ role: 'system', content: [{ type: 'text', text: buildSystemPrompt() }] });
    }
    this.tools = [...builtinTools, createSkillTool(this.registry, this.session)];
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
