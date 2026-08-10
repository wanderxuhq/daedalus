#!/usr/bin/env node
import { loadConfig, missingProvider } from '../config/config.ts';
import type { DaedalusConfig } from '../config/config.ts';
import type { AiProviderName } from '../ai/index.ts';
import { createAiClient } from '../ai/index.ts';
import { DaedalusEngine } from '../core/engine.ts';
import { runRepl } from './repl.ts';
import { runSetupWizard } from './setup.ts';
import { ANSI, renderEvent } from './render.ts';

function parseFlags(argv: string[]) {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--provider') flags.provider = argv[++i];
    else if (a === '--model') flags.model = argv[++i];
    else if (a === '--base-url') flags.baseUrl = argv[++i];
    else if (a === '--help') flags.help = '1';
  }
  return flags;
}

const flags = parseFlags(process.argv.slice(2));
if (flags.help) {
  console.log('daedalus — a terminal agent\n\nUsage: daedalus [--provider openai|anthropic] [--model M] [--base-url URL]\n\nConfig: ~/.daedalus/config.json and DAEDALUS_* env vars. First run starts an interactive setup.');
  process.exit(0);
}

let base: DaedalusConfig;
const missing = missingProvider(process.env, flags.provider as AiProviderName | undefined);
if (missing) {
  const configured = await runSetupWizard({ defaultProvider: missing });
  if (!configured) process.exit(1);
  base = configured;
} else {
  base = loadConfig();
}
const config = {
  provider: (flags.provider ?? base.provider) as 'openai' | 'anthropic',
  apiKey: base.apiKey,
  baseURL: flags.baseUrl ?? base.baseURL,
  model: flags.model ?? base.model,
};
const client = createAiClient(config);

console.log(`${ANSI.bold}Daedalus${ANSI.reset} — agent ready (${config.provider}${config.model ? ` / ${config.model}` : ''})`);
const engine = new DaedalusEngine({
  client,
  cwd: process.cwd(),
});
engine.subscribe(renderEvent);
await runRepl(engine);
engine.dispose();
