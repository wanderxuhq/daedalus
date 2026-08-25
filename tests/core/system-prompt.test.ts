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

test('layered main-agent prompt includes explorers and orchestration for delegation', () => {
  const p = buildSystemPrompt({ tools: [...DEFAULT_MAIN_AGENT_TOOLS] });
  // Individual tools
  for (const tool of ['read', 'write', 'edit', 'bash', 'Skill', 'delegate']) {
    assert.ok(p.includes(`- ${tool}:`), `layered prompt should advertise ${tool}`);
  }
  // ls/grep/glob merge into one line when all present
  assert.ok(p.includes('ls, grep, glob'), `layered prompt should advertise ls, grep, glob`);
  // The orchestration section is present (delegate is included).
  assert.ok(p.includes('Orchestration'));
  // All builtin tools are available — no "NOT available" note.
  assert.ok(!p.includes('NOT available'));
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
