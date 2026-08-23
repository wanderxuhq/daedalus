import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AiProviderName } from '../ai/index.ts';
import type { HookConfig } from '../core/hooks.ts';

export interface DaedalusConfig {
  provider: AiProviderName;
  apiKey: string;
  baseURL?: string;
  model?: string;
  maxContextTokens?: number;
  /** Auto-approve tool permission prompts (bash/write) instead of asking y/n. */
  autoApprove?: boolean;
  /** Extended thinking. Defaults to ON — send a thinking budget to the model. */
  thinking?: boolean;
  /** Thinking budget in tokens (Anthropic) / effort (OpenAI-compatible). */
  thinkingBudgetTokens?: number;
  /** Lifecycle hooks (PreToolUse/PostToolUse/stop/notification); config file only. */
  hooks?: HookConfig;
}

interface FileConfig {
  provider?: string;
  apiKey?: string;
  baseURL?: string;
  model?: string;
  maxContextTokens?: number;
  autoApprove?: boolean;
  thinking?: boolean;
  thinkingBudgetTokens?: number;
  hooks?: HookConfig;
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

/** Config as resolved without throwing — the apiKey may still be missing. */
export type ResolvedConfig = Omit<DaedalusConfig, 'apiKey'> & { apiKey?: string };

/** Resolve config from env + file without throwing on a missing key. */
export function resolveConfig(env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  const file = readFileConfig(env);
  const provider = (env.DAEDALUS_PROVIDER ?? file.provider ?? 'anthropic') as AiProviderName;
  const apiKey = env.DAEDALUS_API_KEY
    ?? (provider === 'openai' ? env.OPENAI_API_KEY : env.ANTHROPIC_API_KEY)
    ?? file.apiKey;
  const envTokens = env.DAEDALUS_MAX_CONTEXT_TOKENS === undefined ? undefined : Number(env.DAEDALUS_MAX_CONTEXT_TOKENS);
  const rawTokens = envTokens ?? file.maxContextTokens;
  const maxContextTokens = typeof rawTokens === 'number' && Number.isFinite(rawTokens) ? rawTokens : undefined;
  const envAuto = env.DAEDALUS_AUTO_APPROVE;
  const autoApprove = envAuto === undefined
    ? file.autoApprove
    : envAuto !== '' && envAuto !== '0' && envAuto.toLowerCase() !== 'false';
  // Thinking is ON by default; explicitly opt out with DAEDALUS_THINKING=0/false
  // or "thinking": false in the config file.
  const envThinking = env.DAEDALUS_THINKING;
  const thinking = envThinking === undefined
    ? (file.thinking ?? true)
    : envThinking !== '' && envThinking !== '0' && envThinking.toLowerCase() !== 'false';
  const envBudget = env.DAEDALUS_THINKING_BUDGET === undefined ? undefined : Number(env.DAEDALUS_THINKING_BUDGET);
  const rawBudget = envBudget ?? file.thinkingBudgetTokens;
  const thinkingBudgetTokens = typeof rawBudget === 'number' && Number.isFinite(rawBudget) && rawBudget > 0 ? rawBudget : undefined;
  return {
    provider,
    apiKey,
    baseURL: env.DAEDALUS_BASE_URL ?? file.baseURL,
    model: env.DAEDALUS_MODEL ?? file.model,
    ...(maxContextTokens !== undefined ? { maxContextTokens } : {}),
    ...(autoApprove !== undefined ? { autoApprove } : {}),
    thinking,
    ...(thinkingBudgetTokens !== undefined ? { thinkingBudgetTokens } : {}),
    ...(file.hooks ? { hooks: file.hooks } : {}),
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DaedalusConfig {
  const cfg = resolveConfig(env);
  if (!cfg.apiKey) {
    const varName = cfg.provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
    throw new Error(`No API key for provider "${cfg.provider}". Set ${varName} (or DAEDALUS_API_KEY) or add apiKey to ~/.daedalus/config.json`);
  }
  return cfg as DaedalusConfig;
}

/**
 * The provider that has no API key configured for it, or null when the config
 * is complete. `providerOverride` lets a CLI --provider flag redirect which
 * provider is checked (a key for the default provider is not reused for
 * another provider).
 */
export function missingProvider(env: NodeJS.ProcessEnv = process.env, providerOverride?: AiProviderName): AiProviderName | null {
  const cfg = resolveConfig(env);
  const provider = providerOverride ?? cfg.provider;
  const apiKey = env.DAEDALUS_API_KEY
    ?? (provider === 'openai' ? env.OPENAI_API_KEY : env.ANTHROPIC_API_KEY)
    ?? (provider === cfg.provider ? cfg.apiKey : undefined);
  return apiKey ? null : provider;
}
