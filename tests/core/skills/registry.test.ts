import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillRegistry, parseSkillDir } from '../../../src/core/skills/registry.ts';

function makeSkill(base: string, name: string, content: string): void {
  mkdirSync(join(base, name), { recursive: true });
  writeFileSync(join(base, name, 'SKILL.md'), content);
}

test('parseSkillDir reads frontmatter and body', () => {
  const base = join(tmpdir(), `dae-sk-${Date.now()}`);
  mkdirSync(base, { recursive: true });
  makeSkill(base, 'review', `---
name: review
description: Review code
when_to_use: On code review requests
user-invocable: true
---
Body text here`);
  const info = parseSkillDir(join(base, 'review'));
  assert.ok(info);
  assert.equal(info.name, 'review');
  assert.equal(info.description, 'Review code');
  assert.equal(info.whenToUse, 'On code review requests');
  assert.equal(info.body, 'Body text here');
  assert.equal(info.userInvocable, true);
  rmSync(base, { recursive: true, force: true });
});

test('name falls back to directory name when omitted', () => {
  const base = join(tmpdir(), `dae-sk-${Date.now()}`);
  mkdirSync(base, { recursive: true });
  makeSkill(base, 'dir-name', `---
description: No name here
---
Body`);
  const info = parseSkillDir(join(base, 'dir-name'));
  assert.ok(info);
  assert.equal(info.name, 'dir-name');
  rmSync(base, { recursive: true, force: true });
});

test('missing SKILL.md returns null', () => {
  const base = join(tmpdir(), `dae-sk-${Date.now()}`);
  mkdirSync(base, { recursive: true });
  mkdirSync(join(base, 'nodoc'));
  assert.equal(parseSkillDir(join(base, 'nodoc')), null);
  rmSync(base, { recursive: true, force: true });
});

test('registry discovers skills in dirs and respects precedence', () => {
  const userDir = join(tmpdir(), `dae-user-${Date.now()}`);
  const projDir = join(tmpdir(), `dae-proj-${Date.now()}`);
  mkdirSync(userDir, { recursive: true });
  mkdirSync(projDir, { recursive: true });
  makeSkill(userDir, 'dup', '---\nname: dup\ndescription: user version\n---\nuser');
  makeSkill(userDir, 'only-user', '---\nname: only-user\ndescription: U\n---\nu');
  makeSkill(projDir, 'dup', '---\nname: dup\ndescription: proj version\n---\nproj');
  const reg = new SkillRegistry([projDir, userDir]); // proj first = higher precedence
  assert.equal(reg.get('dup')!.description, 'proj version');
  assert.equal(reg.get('only-user')!.description, 'U');
  rmSync(userDir, { recursive: true, force: true });
  rmSync(projDir, { recursive: true, force: true });
});

test('renderListing is budgeted to maxChars', () => {
  const base = join(tmpdir(), `dae-sk-${Date.now()}`);
  mkdirSync(base, { recursive: true });
  makeSkill(base, 'aaa', '---\nname: aaa\ndescription: A very long description for aaa\n---\nb');
  makeSkill(base, 'bbb', '---\nname: bbb\ndescription: B\n---\nb');
  const reg = new SkillRegistry([base]);
  const listing = reg.renderListing(20);
  assert.ok(listing.length <= 20);
  assert.ok(listing.includes('bbb'));
  rmSync(base, { recursive: true, force: true });
});

test('default constructor discovers from project .claude/skills chain', () => {
  const reg = new SkillRegistry();
  assert.ok(Array.isArray(reg.names));
});
