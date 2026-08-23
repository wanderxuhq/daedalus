import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AiClient, Message, StreamEvent } from '../../src/ai/types.ts';
import { loadMemory, MEMORY_FILE } from '../../src/core/memory.ts';
import { buildSubagentPrompt } from '../../src/core/delegate.ts';

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'daedalus-memory-'));
}

const textClient = (text: string): AiClient => ({
  async *streamChat(): AsyncGenerator<StreamEvent> {
    yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text }] } };
  },
});

test('memory: loads the nearest DAEDALUS.md walking up from cwd', () => {
  const root = tmpProject();
  try {
    const nested = join(root, 'a', 'b', 'c');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(root, MEMORY_FILE), 'PROJECT RULES');
    const mem = loadMemory(nested, { userDir: join(root, 'no-user') });
    assert.deepEqual(mem.sources, [join(root, MEMORY_FILE)]);
    assert.equal(mem.text, 'PROJECT RULES');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('memory: user memory comes first, project memory overrides on conflict', () => {
  const root = tmpProject();
  try {
    const userDir = join(root, 'user');
    const project = join(root, 'proj', 'src');
    mkdirSync(userDir, { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(join(userDir, MEMORY_FILE), 'USER RULES');
    writeFileSync(join(root, 'proj', MEMORY_FILE), 'PROJECT RULES');
    const mem = loadMemory(project, { userDir });
    assert.deepEqual(mem.sources, [join(userDir, MEMORY_FILE), join(root, 'proj', MEMORY_FILE)]);
    assert.ok(mem.text.includes('USER RULES'));
    assert.ok(mem.text.includes('PROJECT RULES'));
    // Project text comes last (highest precedence).
    assert.ok(mem.text.indexOf('USER RULES') < mem.text.indexOf('PROJECT RULES'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('memory: no files found yields empty memory', () => {
  const root = tmpProject();
  try {
    const mem = loadMemory(root, { userDir: join(root, 'no-user') });
    assert.deepEqual(mem.sources, []);
    assert.equal(mem.text, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('memory: engine injects DAEDALUS.md into the main system prompt', async () => {
  const { DaedalusEngine } = await import('../../src/core/engine.ts');
  const root = tmpProject();
  try {
    writeFileSync(join(root, MEMORY_FILE), 'ALWAYS use tabs, never spaces');
    const engine = new DaedalusEngine({
      client: textClient('ok'),
      cwd: root,
      askPermission: (async () => true) as (action: string, target: string) => Promise<boolean>,
      skillDirs: [],
      maxIterations: 5,
    });
    assert.deepEqual(engine.memorySources, [join(root, MEMORY_FILE)]);
    await engine.run('hello');
    const system = engine.getSessionState().messages[0] as Message;
    const text = system.content.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text).join('');
    assert.ok(text.includes('# Project memory'));
    assert.ok(text.includes('ALWAYS use tabs, never spaces'));
    await engine.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('memory: subagent system prompt carries the same memory text', () => {
  const prompt = buildSubagentPrompt({ memory: 'REPO CONVENTION: no semicolons' });
  assert.ok(prompt.includes('# Project memory'));
  assert.ok(prompt.includes('REPO CONVENTION: no semicolons'));
});
