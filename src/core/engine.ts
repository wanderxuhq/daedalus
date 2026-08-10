import type { AiClient } from '../ai/types.ts';
import type { Tool } from '../tools/types.ts';
import { tools as builtinTools } from '../tools/registry.ts';
import type { CoreEvent } from './events.ts';
import { Session } from './session.ts';
import { SkillRegistry } from './skills/registry.ts';
import type { SkillInfo } from './skills/types.ts';
import { createSkillTool } from './skills/skill-tool.ts';
import { runAgent } from '../agent/loop.ts';
import { buildSystemPrompt } from './system-prompt.ts';

export interface EngineOptions {
  client: AiClient;
  cwd: string;
  /** Optional; the REPL installs its own via {@link setAskPermission}. Defaults to deny. */
  askPermission?: (action: string, target: string) => Promise<boolean>;
  skillDirs?: string[];
  maxIterations?: number;
}

export class DaedalusEngine {
  private session: Session;
  private registry: SkillRegistry;
  private tools: Tool[];
  private client: AiClient;
  private cwd: string;
  private askPermission: (action: string, target: string) => Promise<boolean>;
  private maxIterations?: number;

  constructor(opts: EngineOptions) {
    this.session = new Session();
    this.session.start();
    // Stable system-prompt prefix: injected ONCE at construction, before any
    // runAgent call. runAgent/loadSkill never touch it (spec §4; pre-flight ruling).
    this.session.addMessage({ role: 'system', content: [{ type: 'text', text: buildSystemPrompt() }] });
    this.registry = new SkillRegistry(opts.skillDirs);
    this.client = opts.client;
    this.cwd = opts.cwd;
    this.askPermission = opts.askPermission ?? (async () => false);
    this.maxIterations = opts.maxIterations;
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
    return runAgent({
      client: this.client,
      session: this.session,
      prompt,
      tools: this.tools,
      cwd: this.cwd,
      askPermission: this.askPermission,
      maxIterations: this.maxIterations,
    });
  }

  dispose(): void {
    this.session.dispose();
  }
}
