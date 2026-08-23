import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt, DEFAULT_MAIN_AGENT_TOOLS, BUILTIN_TOOL_NAMES } from '../../src/core/system-prompt.ts';

test('buildSystemPrompt mentions Daedalus and tools guidance', () => {
  const p = buildSystemPrompt();
  assert.ok(p.includes('Daedalus'));
  assert.ok(p.length > 50);
});

test('buildSystemPrompt is deterministic (stable prefix)', () => {
  assert.equal(buildSystemPrompt(), buildSystemPrompt());
});

test('full toolset prompt advertises every tool, including explorers', () => {
  const p = buildSystemPrompt({ tools: [...BUILTIN_TOOL_NAMES, 'Skill', 'delegate'] });
  for (const tool of ['bash', 'read', 'write', 'edit', 'Skill', 'delegate']) {
    assert.ok(p.includes(`- ${tool}:`), `full prompt should advertise ${tool}`);
  }
  assert.ok(p.includes('ls, grep, glob: explore and search'));
  // With all explorers present there is no "delegated tools" note.
  assert.ok(!p.includes('NOT available'));
});

test('layered main-agent prompt removes explorers and forces delegation', () => {
  const p = buildSystemPrompt({ tools: [...DEFAULT_MAIN_AGENT_TOOLS] });
  for (const kept of ['read', 'write', 'edit', 'Skill', 'delegate']) {
    assert.ok(p.includes(`- ${kept}:`), `layered prompt should advertise ${kept}`);
  }
  for (const banned of ['bash', 'ls', 'grep', 'glob']) {
    assert.ok(!p.includes(`- ${banned}:`), `layered prompt must not advertise ${banned}`);
  }
  // The forced-delegation framing is present.
  assert.ok(p.includes('Orchestration: you are the author'));
  assert.ok(p.includes('bash, ls, grep, glob are NOT available'));
});

test('subagent prompt advertises exactly the builtins (no Skill, no delegate, no orchestration)', () => {
  const p = buildSystemPrompt({ tools: [...BUILTIN_TOOL_NAMES] });
  for (const tool of ['bash', 'read', 'write', 'edit']) {
    assert.ok(p.includes(`- ${tool}:`), `subagent prompt should advertise ${tool}`);
  }
  // The three explorers are merged into the classic one-liner.
  assert.ok(p.includes('ls, grep, glob: explore and search'));
  assert.ok(!p.includes('- Skill:'));
  assert.ok(!p.includes('- delegate:'));
  assert.ok(!p.includes('Orchestration'));
});
