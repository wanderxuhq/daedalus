import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, missingProvider } from '../../src/config/config.ts';

function tempConfigFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'daedalus-config-'));
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, contents);
  return configPath;
}

// Every test must pin DAEDALUS_CONFIG_PATH to a path that never exists, so no
// test can leak a real ~/.daedalus/config.json from the developer's machine.
const NO_CONFIG_PATH = '/nonexistent/daedalus-config.json';

test('defaults to anthropic with ANTHROPIC_API_KEY', () => {
  const cfg = loadConfig({ ANTHROPIC_API_KEY: 'sk-ant-1', DAEDALUS_CONFIG_PATH: NO_CONFIG_PATH } as NodeJS.ProcessEnv);
  assert.equal(cfg.provider, 'anthropic');
  assert.equal(cfg.apiKey, 'sk-ant-1');
});

test('DAEDALUS_PROVIDER overrides default', () => {
  const cfg = loadConfig({ DAEDALUS_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-1', DAEDALUS_CONFIG_PATH: NO_CONFIG_PATH } as NodeJS.ProcessEnv);
  assert.equal(cfg.provider, 'openai');
  assert.equal(cfg.apiKey, 'sk-1');
});

test('DAEDALUS_API_KEY takes precedence', () => {
  const cfg = loadConfig({ DAEDALUS_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-env', DAEDALUS_API_KEY: 'sk-dae', DAEDALUS_CONFIG_PATH: NO_CONFIG_PATH } as NodeJS.ProcessEnv);
  assert.equal(cfg.apiKey, 'sk-dae');
});

test('DAEDALUS_MODEL and BASE_URL pass through', () => {
  const cfg = loadConfig({ DAEDALUS_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-1', DAEDALUS_MODEL: 'gpt-4.1', DAEDALUS_BASE_URL: 'http://localhost:11434/v1', DAEDALUS_CONFIG_PATH: NO_CONFIG_PATH } as NodeJS.ProcessEnv);
  assert.equal(cfg.model, 'gpt-4.1');
  assert.equal(cfg.baseURL, 'http://localhost:11434/v1');
});

test('missing key throws helpful error', () => {
  assert.throws(() => loadConfig({ DAEDALUS_CONFIG_PATH: NO_CONFIG_PATH } as NodeJS.ProcessEnv), /API key/);
});

test('missingProvider returns the unconfigured provider, or null when key present', () => {
  assert.equal(missingProvider({ DAEDALUS_CONFIG_PATH: NO_CONFIG_PATH } as NodeJS.ProcessEnv), 'anthropic');
  assert.equal(missingProvider({ DAEDALUS_PROVIDER: 'openai', DAEDALUS_CONFIG_PATH: NO_CONFIG_PATH } as NodeJS.ProcessEnv), 'openai');
  assert.equal(missingProvider({ ANTHROPIC_API_KEY: 'sk-ant-1', DAEDALUS_CONFIG_PATH: NO_CONFIG_PATH } as NodeJS.ProcessEnv), null);
});

test('missingProvider honors a providerOverride without reusing the default providers key', () => {
  // The default provider has a key, but an explicitly requested different provider does not.
  assert.equal(missingProvider({ ANTHROPIC_API_KEY: 'sk-ant-1', DAEDALUS_CONFIG_PATH: NO_CONFIG_PATH } as NodeJS.ProcessEnv, 'openai'), 'openai');
  // And the override's own key satisfies it.
  assert.equal(missingProvider({ OPENAI_API_KEY: 'sk-1', DAEDALUS_CONFIG_PATH: NO_CONFIG_PATH } as NodeJS.ProcessEnv, 'openai'), null);
});

test('DAEDALUS_CONFIG_PATH file merges under env-provided fields and exposes file-only fields', () => {
  const configPath = tempConfigFile(JSON.stringify({
    provider: 'openai',
    apiKey: 'sk-file',
    model: 'gpt-4o-mini',
    baseURL: 'http://file.local',
  }));
  const cfg = loadConfig({
    DAEDALUS_CONFIG_PATH: configPath,
    DAEDALUS_MODEL: 'env-model', // env wins over file
  } as NodeJS.ProcessEnv);
  assert.equal(cfg.provider, 'openai');          // from file (no env provider)
  assert.equal(cfg.apiKey, 'sk-file');           // from file (no env key)
  assert.equal(cfg.model, 'env-model');          // env overrides file
  assert.equal(cfg.baseURL, 'http://file.local'); // file-only field appears
});

test('null config file content falls back to defaults without throwing', () => {
  const configPath = tempConfigFile('null');
  const cfg = loadConfig({
    DAEDALUS_CONFIG_PATH: configPath,
    ANTHROPIC_API_KEY: 'sk-ant-1',
  } as NodeJS.ProcessEnv);
  assert.equal(cfg.provider, 'anthropic');
  assert.equal(cfg.apiKey, 'sk-ant-1');
});

test('config file with null provider field falls back to defaults', () => {
  const configPath = tempConfigFile(JSON.stringify({ provider: null }));
  const cfg = loadConfig({
    DAEDALUS_CONFIG_PATH: configPath,
    ANTHROPIC_API_KEY: 'sk-ant-1',
  } as NodeJS.ProcessEnv);
  assert.equal(cfg.provider, 'anthropic');
  assert.equal(cfg.apiKey, 'sk-ant-1');
});

test('DAEDALUS_MAX_CONTEXT_TOKENS parses into maxContextTokens', () => {
  const cfg = loadConfig({ ANTHROPIC_API_KEY: 'sk-ant-1', DAEDALUS_CONFIG_PATH: NO_CONFIG_PATH, DAEDALUS_MAX_CONTEXT_TOKENS: '50000' } as NodeJS.ProcessEnv);
  assert.equal(cfg.maxContextTokens, 50000);
});

test('invalid DAEDALUS_MAX_CONTEXT_TOKENS is dropped', () => {
  const cfg = loadConfig({ ANTHROPIC_API_KEY: 'sk-ant-1', DAEDALUS_CONFIG_PATH: NO_CONFIG_PATH, DAEDALUS_MAX_CONTEXT_TOKENS: 'abc' } as NodeJS.ProcessEnv);
  assert.equal(cfg.maxContextTokens, undefined);
});

test('maxContextTokens from the config file is exposed', () => {
  const configPath = tempConfigFile(JSON.stringify({ provider: 'openai', apiKey: 'sk-file', maxContextTokens: 200000 }));
  const cfg = loadConfig({ DAEDALUS_CONFIG_PATH: configPath } as NodeJS.ProcessEnv);
  assert.equal(cfg.maxContextTokens, 200000);
});

test('DAEDALUS_AUTO_APPROVE parses into autoApprove', () => {
  const cfg = loadConfig({ ANTHROPIC_API_KEY: 'sk-ant-1', DAEDALUS_CONFIG_PATH: NO_CONFIG_PATH, DAEDALUS_AUTO_APPROVE: '1' } as NodeJS.ProcessEnv);
  assert.equal(cfg.autoApprove, true);
});

test('DAEDALUS_AUTO_APPROVE=0 disables autoApprove', () => {
  const cfg = loadConfig({ ANTHROPIC_API_KEY: 'sk-ant-1', DAEDALUS_CONFIG_PATH: NO_CONFIG_PATH, DAEDALUS_AUTO_APPROVE: '0' } as NodeJS.ProcessEnv);
  assert.equal(cfg.autoApprove, false);
});

test('DAEDALUS_AUTO_APPROVE=false disables autoApprove', () => {
  const cfg = loadConfig({ ANTHROPIC_API_KEY: 'sk-ant-1', DAEDALUS_CONFIG_PATH: NO_CONFIG_PATH, DAEDALUS_AUTO_APPROVE: 'false' } as NodeJS.ProcessEnv);
  assert.equal(cfg.autoApprove, false);
});

test('autoApprove from the config file is exposed', () => {
  const configPath = tempConfigFile(JSON.stringify({ provider: 'openai', apiKey: 'sk-file', autoApprove: true }));
  const cfg = loadConfig({ DAEDALUS_CONFIG_PATH: configPath } as NodeJS.ProcessEnv);
  assert.equal(cfg.autoApprove, true);
});

test('env DAEDALUS_AUTO_APPROVE overrides the config file', () => {
  const configPath = tempConfigFile(JSON.stringify({ provider: 'openai', apiKey: 'sk-file', autoApprove: true }));
  const cfg = loadConfig({ DAEDALUS_CONFIG_PATH: configPath, DAEDALUS_AUTO_APPROVE: '0' } as NodeJS.ProcessEnv);
  assert.equal(cfg.autoApprove, false);
});

test('thinking defaults to ON', () => {
  const cfg = loadConfig({ ANTHROPIC_API_KEY: 'sk-ant-1', DAEDALUS_CONFIG_PATH: NO_CONFIG_PATH } as NodeJS.ProcessEnv);
  assert.equal(cfg.thinking, true);
});

test('DAEDALUS_THINKING=0 and false disable thinking', () => {
  const off = loadConfig({ ANTHROPIC_API_KEY: 'sk-ant-1', DAEDALUS_CONFIG_PATH: NO_CONFIG_PATH, DAEDALUS_THINKING: '0' } as NodeJS.ProcessEnv);
  assert.equal(off.thinking, false);
  const off2 = loadConfig({ ANTHROPIC_API_KEY: 'sk-ant-1', DAEDALUS_CONFIG_PATH: NO_CONFIG_PATH, DAEDALUS_THINKING: 'false' } as NodeJS.ProcessEnv);
  assert.equal(off2.thinking, false);
});

test('thinking:false in the config file disables the default', () => {
  const configPath = tempConfigFile(JSON.stringify({ provider: 'openai', apiKey: 'sk-file', thinking: false }));
  const cfg = loadConfig({ DAEDALUS_CONFIG_PATH: configPath } as NodeJS.ProcessEnv);
  assert.equal(cfg.thinking, false);
});

test('DAEDALUS_THINKING_BUDGET parses into thinkingBudgetTokens', () => {
  const cfg = loadConfig({ ANTHROPIC_API_KEY: 'sk-ant-1', DAEDALUS_CONFIG_PATH: NO_CONFIG_PATH, DAEDALUS_THINKING_BUDGET: '8192' } as NodeJS.ProcessEnv);
  assert.equal(cfg.thinkingBudgetTokens, 8192);
});
