import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AiProviderName } from '../ai/index.ts';

export interface DaedalusConfig {
  provider: AiProviderName;
  apiKey: string;
  baseURL?: string;
  model?: string;
}

interface FileConfig {
  provider?: string;
  apiKey?: string;
  baseURL?: string;
  model?: string;
}

function readFileConfig(env: NodeJS.ProcessEnv): FileConfig {
  try {
    const configPath = env.DAEDALUS_CONFIG_PATH ?? join(homedir(), '.daedalus', 'config.json');
    const raw = readFileSync(configPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    // Guard against e.g. a `null` config file — JSON.parse('null') yields null
    // and downstream `file.provider` access would throw outside this try/catch.
    if (parsed === null || typeof parsed !== 'object') return {};
    return parsed as FileConfig;
  } catch {
    return {};
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DaedalusConfig {
  const file = readFileConfig(env);
  const provider = (env.DAEDALUS_PROVIDER ?? file.provider ?? 'anthropic') as AiProviderName;
  const apiKey = env.DAEDALUS_API_KEY
    ?? (provider === 'openai' ? env.OPENAI_API_KEY : env.ANTHROPIC_API_KEY)
    ?? file.apiKey;
  if (!apiKey) {
    const varName = provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
    throw new Error(`No API key for provider "${provider}". Set ${varName} (or DAEDALUS_API_KEY) or add apiKey to ~/.daedalus/config.json`);
  }
  return {
    provider,
    apiKey,
    baseURL: env.DAEDALUS_BASE_URL ?? file.baseURL,
    model: env.DAEDALUS_MODEL ?? file.model,
  };
}
