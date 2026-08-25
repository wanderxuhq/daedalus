import { test } from 'node:test';
import assert from 'node:assert/strict';
import { truncateResult, clearSpilledOutputs, TOOL_OUTPUT_CAP } from '../../src/tools/output.ts';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('output: short content is returned as-is', async () => {
  const short = 'Hello, world!';
  const result = await truncateResult(short);
  assert.equal(result.content, short);
  assert.equal(result.retained, short.length);
});

test('output: content exactly at cap is returned as-is', async () => {
  const exact = 'x'.repeat(TOOL_OUTPUT_CAP);
  const result = await truncateResult(exact);
  assert.equal(result.content, exact);
  assert.equal(result.retained, TOOL_OUTPUT_CAP);
});

test('output: long content is truncated and spilled to file', async () => {
  const long = 'y'.repeat(TOOL_OUTPUT_CAP + 1000);
  const result = await truncateResult(long);
  
  // Content should be truncated to cap
  assert.ok(result.content.length < long.length);
  assert.equal(result.retained, TOOL_OUTPUT_CAP);
  
  // Should contain truncation message with file path
  assert.ok(result.content.includes(`[output truncated at ${TOOL_OUTPUT_CAP} chars`));
  assert.ok(result.content.includes('read it with the read tool'));
  
  // Extract file path from content
  const pathMatch = result.content.match(/saved to ([^\s;]+)/);
  assert.ok(pathMatch, 'Should contain file path');
  const filePath = pathMatch![1];
  
  // File should exist and contain full content
  assert.ok(existsSync(filePath), 'Spill file should exist');
  const fileContent = readFileSync(filePath, 'utf8');
  assert.equal(fileContent, long);
  
  // Cleanup
  clearSpilledOutputs();
});

test('output: custom maxChars parameter works', async () => {
  const content = 'test content';
  const customMax = 5;
  const result = await truncateResult(content, customMax);
  
  assert.ok(result.content.startsWith('test ')); // First 5 chars
  assert.ok(result.content.includes('[output truncated'));
  assert.equal(result.retained, customMax);
});

test('output: empty content is handled', async () => {
  const result = await truncateResult('');
  assert.equal(result.content, '');
  assert.equal(result.retained, 0);
});

test('output: clearSpilledOutputs removes all spill files', async () => {
  // Create two spill files
  const content1 = 'a'.repeat(TOOL_OUTPUT_CAP + 100);
  const content2 = 'b'.repeat(TOOL_OUTPUT_CAP + 200);
  
  const result1 = await truncateResult(content1);
  const result2 = await truncateResult(content2);
  
  // Extract file paths
  const path1 = result1.content.match(/saved to ([^\s;]+)/)![1];
  const path2 = result2.content.match(/saved to ([^\s;]+)/)![1];
  
  assert.ok(existsSync(path1));
  assert.ok(existsSync(path2));
  
  // Clear all
  clearSpilledOutputs();
  
  assert.ok(!existsSync(path1));
  assert.ok(!existsSync(path2));
});

test('output: concurrent truncations create separate files', async () => {
  const content1 = 'x'.repeat(TOOL_OUTPUT_CAP + 500);
  const content2 = 'y'.repeat(TOOL_OUTPUT_CAP + 600);
  
  const [result1, result2] = await Promise.all([
    truncateResult(content1),
    truncateResult(content2),
  ]);
  
  const path1 = result1.content.match(/saved to ([^\s;]+)/)![1];
  const path2 = result2.content.match(/saved to ([^\s;]+)/)![1];
  
  // Files should be different
  assert.notEqual(path1, path2);
  
  // Both should exist
  assert.ok(existsSync(path1));
  assert.ok(existsSync(path2));
  
  // Cleanup
  clearSpilledOutputs();
});

test('output: truncation preserves content up to cap', async () => {
  const prefix = 'A'.repeat(100);
  const middle = 'B'.repeat(TOOL_OUTPUT_CAP - 100 - 50);
  const suffix = 'C'.repeat(1000);
  const content = prefix + middle + suffix;
  
  const result = await truncateResult(content);
  
  // First part should be intact
  assert.ok(result.content.startsWith(prefix));
  assert.ok(result.content.includes(middle.slice(0, 50)));
  
  // Full content in file
  const filePath = result.content.match(/saved to ([^\s;]+)/)![1];
  const fileContent = readFileSync(filePath, 'utf8');
  assert.equal(fileContent, content);
  
  clearSpilledOutputs();
});
