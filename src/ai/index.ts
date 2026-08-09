import { createAnthropicClient } from './providers/anthropic.ts';
import { createOpenAIClient } from './providers/openai.ts';

export type AiProviderName = 'openai' | 'anthropic';

export interface AiClientConfig {
  provider: AiProviderName;
  apiKey: string;
  baseURL?: string;
  model?: string;
  maxRetries?: number;
  timeoutMs?: number;
}

export function createAiClient(config: AiClientConfig) {
  switch (config.provider) {
    case 'anthropic':
      return createAnthropicClient(config);
    case 'openai':
      return createOpenAIClient(config);
    default:
      throw new Error(`Unknown provider: ${config.provider as string}`);
  }
}

export type { AiClient, StreamEvent, Message, ContentBlock, ToolDefinition, ChatParams } from './types.ts';
export { AiError } from './errors.ts';
export type { AiErrorKind } from './errors.ts';
