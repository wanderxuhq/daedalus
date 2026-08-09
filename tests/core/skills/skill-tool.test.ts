import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillRegistry } from '../../../src/core/skills/registry.ts';
import { createSkillTool } from '../../../src/core/skills/skill-tool.ts';
import { Session } from '../../../src/core/session.ts';
import type { ToolContext } from '../../../src/tools/types.ts';

function regWith(names: string[]): SkillRegistry {
  const base = join(tmpdir(), `dae-stool-${Date.now()}`);
  mkdirSync(base, { recursive: true });
  for (const n of names) {
    mkdirSync(join(base, n), { recursive: true });
    writeFileSync(join(base, n, 'SKILL.md'), `---\nname: ${n}\ndescription: desc for ${n}\n---\nBody of ${n}`);
  }
  return new SkillRegistry([base]);
}

function ctx(): ToolContext {
  return { cwd: process.cwd(), askPermission: async () => true };
}

test('Skill tool description includes registry listing', () => {
  const tool = createSkillTool(regWith(['review']), new Session());
  assert.ok(tool.description.includes('review'));
  assert.equal(tool.name, 'Skill');
});

test('Skill tool returns rendered body as content and marks loaded', async () => {
  const session = new Session();
  const tool = createSkillTool(regWith(['review']), session);
  const res = await tool.execute({ name: 'review' }, ctx());
  assert.equal(res.isError, undefined);
  assert.ok(res.content.includes('Body of review'));
  assert.equal(session.isSkillLoaded('review'), true);
});

test('re-invoking same skill returns dedup note, no second body', async () => {
  const session = new Session();
  const tool = createSkillTool(regWith(['review']), session);
  await tool.execute({ name: 'review' }, ctx());
  const res2 = await tool.execute({ name: 'review' }, ctx());
  assert.ok(res2.content.includes('already loaded'));
  assert.ok(!res2.content.includes('Body of review'));
});

test('unknown skill name returns error result', async () => {
  const tool = createSkillTool(regWith(['review']), new Session());
  const res = await tool.execute({ name: 'nope' }, ctx());
  assert.equal(res.isError, true);
  assert.ok(res.content.includes('Unknown skill'));
});

test('missing name returns error result', async () => {
  const tool = createSkillTool(regWith(['review']), new Session());
  const res = await tool.execute({}, ctx());
  assert.equal(res.isError, true);
});
