import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/config/config.ts';

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
