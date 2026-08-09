import type { Tool, ToolContext, ToolResult } from '../../tools/types.ts';
import type { SkillRegistry } from './registry.ts';
import type { Session } from '../session.ts';

const LISTING_BUDGET = 1500;

export function createSkillTool(registry: SkillRegistry, session: Session): Tool {
  return {
    name: 'Skill',
    description: `Load a skill by name. Skills provide instructions that guide the conversation. Available skills:\n${registry.renderListing(LISTING_BUDGET) || '(none)'}`,
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
    async execute(input: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const name = (input as { name?: string }).name;
      if (!name) return { content: 'Missing skill name', isError: true };
      const skill = registry.get(name);
      if (!skill) return { content: `Unknown skill: ${name}`, isError: true };
      if (session.isSkillLoaded(name)) {
        return { content: `Skill "${name}" is already loaded.` };
      }
      session.markSkillLoaded(name);
      return { content: skill.body };
    },
  };
}
