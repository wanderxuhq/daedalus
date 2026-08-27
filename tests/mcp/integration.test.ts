import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DaedalusEngine } from '../../src/core/engine.ts';
import type { AiClient, StreamEvent } from '../../src/ai/types.ts';

function textClient(text: string): AiClient {
  return {
    async *streamChat(): AsyncGenerator<StreamEvent> {
      yield { type: 'text_delta', text };
      yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text }] } };
    },
  };
}

test('engine with empty mcp config starts without error', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mcp-integ-'));
  try {
    const engine = new DaedalusEngine({
      client: textClient('ok'),
      cwd,
      mcpConfig: { mcpServers: {} },
    });
    const result = await engine.run('hello');
    assert.equal(result, 'ok');
    await engine.dispose();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('engine without mcpConfig works normally', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mcp-integ-'));
  try {
    const engine = new DaedalusEngine({
      client: textClient('hello'),
      cwd,
    });
    const result = await engine.run('hi');
    assert.equal(result, 'hello');
    await engine.dispose();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
