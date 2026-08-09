import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleReplLine } from '../../src/cli/repl.ts';
import type { SkillInfo } from '../../src/core/skills/types.ts';
import type { CoreEvent } from '../../src/core/events.ts';

class FakeEngine {
  calls: string[] = [];
  skills: SkillInfo[] = [{ name: 'review', description: 'Review code', body: 'Body', userInvocable: true }];
  async run(prompt: string): Promise<string> {
    this.calls.push(`run:${prompt}`);
    return 'done';
  }
  async loadSkill(name: string): Promise<SkillInfo> {
    this.calls.push(`load:${name}`);
    return { name, description: 'x', body: 'Body', userInvocable: true };
  }
  subscribe(_h: (ev: CoreEvent) => void): () => void { return () => {}; }
}

test('/exit returns exit', async () => {
  const engine = new FakeEngine();
  assert.equal(await handleReplLine('/exit', engine), 'exit');
});

test('/skills lists skills', async () => {
  const engine = new FakeEngine();
  assert.equal(await handleReplLine('/skills', engine), 'handled');
  assert.ok(engine.calls.length === 0);
});

test('/skill-name calls loadSkill and returns handled', async () => {
  const engine = new FakeEngine();
  assert.equal(await handleReplLine('/review', engine), 'handled');
  assert.deepEqual(engine.calls, ['load:review']);
});

test('unknown /command returns handled but no crash', async () => {
  const engine = new FakeEngine();
  assert.equal(await handleReplLine('/definitely-not-a-skill', engine), 'handled');
});

test('plain prompt returns unhandled', async () => {
  const engine = new FakeEngine();
  assert.equal(await handleReplLine('hello world', engine), 'unhandled');
});
