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

function readFileConfig(): FileConfig {
  try {
    const raw = readFileSync(join(homedir(), '.daedalus', 'config.json'), 'utf8');
    return JSON.parse(raw) as FileConfig;
  } catch {
    return {};
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DaedalusConfig {
  const file = readFileConfig();
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
