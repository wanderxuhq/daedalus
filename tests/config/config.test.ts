import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../src/config/config.ts';

test('defaults to anthropic with ANTHROPIC_API_KEY', () => {
  const cfg = loadConfig({ ANTHROPIC_API_KEY: 'sk-ant-1' } as NodeJS.ProcessEnv);
  assert.equal(cfg.provider, 'anthropic');
  assert.equal(cfg.apiKey, 'sk-ant-1');
});

test('DAEDALUS_PROVIDER overrides default', () => {
  const cfg = loadConfig({ DAEDALUS_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-1' } as NodeJS.ProcessEnv);
  assert.equal(cfg.provider, 'openai');
  assert.equal(cfg.apiKey, 'sk-1');
});

test('DAEDALUS_API_KEY takes precedence', () => {
  const cfg = loadConfig({ DAEDALUS_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-env', DAEDALUS_API_KEY: 'sk-dae' } as NodeJS.ProcessEnv);
  assert.equal(cfg.apiKey, 'sk-dae');
});

test('DAEDALUS_MODEL and BASE_URL pass through', () => {
  const cfg = loadConfig({ DAEDALUS_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-1', DAEDALUS_MODEL: 'gpt-4.1', DAEDALUS_BASE_URL: 'http://localhost:11434/v1' } as NodeJS.ProcessEnv);
  assert.equal(cfg.model, 'gpt-4.1');
  assert.equal(cfg.baseURL, 'http://localhost:11434/v1');
});

test('missing key throws helpful error', () => {
  assert.throws(() => loadConfig({} as NodeJS.ProcessEnv), /API key/);
});
