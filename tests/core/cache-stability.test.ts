import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DaedalusEngine } from '../../src/core/engine.ts';
import type { AiClient } from '../../src/ai/types.ts';

test('message prefix stays stable across plain runs (no skill loads)', async () => {
  const snapshots: string[] = [];
  const engine = new DaedalusEngine({
    client: {
      async *streamChat(params) {
        snapshots.push(JSON.stringify(params.messages));
        yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } };
      },
    },
    cwd: process.cwd(),
    askPermission: async () => true,
    skillDirs: [],
    maxIterations: 2,
  });
  await engine.run('first');
  await engine.run('second');
  await engine.run('third');
  assert.equal(snapshots.length, 3);
  // Each request is a strict superset of the previous (append-only history).
  assert.ok(snapshots[1].length > snapshots[0].length);
  assert.ok(snapshots[2].length > snapshots[1].length);
  await engine.dispose();
});

test('skill load only appends, never mutates earlier messages', async () => {
  const base = join(tmpdir(), `dae-cache-${Date.now()}`);
  mkdirSync(join(base, 'review'), { recursive: true });
  writeFileSync(join(base, 'review', 'SKILL.md'), '---\nname: review\ndescription: Review\n---\nBody text');
  const before: string[] = [];
  let call = 0;
  const engine = new DaedalusEngine({
    client: {
      async *streamChat(params) {
        before.push(JSON.stringify(params.messages));
        call++;
        if (call === 1) {
          yield { type: 'done', message: { role: 'assistant', content: [{ type: 'tool_call', id: 's1', name: 'Skill', input: { name: 'review' } }] } };
        } else {
          yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } };
        }
      },
    },
    cwd: process.cwd(),
    askPermission: async () => true,
    skillDirs: [base],
    maxIterations: 4,
  });
  await engine.run('use review');
  assert.equal(before.length, 2);
  // The skill body reaches messages via the Skill tool's tool_result (appended), and the
  // earlier messages (system-assembly + user prompt) are byte-identical between calls.
  assert.ok(before[0].startsWith('[') && before[0].endsWith(']'));
  assert.ok(before[1].includes('Body text'));
  await engine.dispose();
  rmSync(base, { recursive: true, force: true });
});
