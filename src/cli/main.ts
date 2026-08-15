#!/usr/bin/env node
import { loadConfig, missingProvider } from '../config/config.ts';
import type { DaedalusConfig } from '../config/config.ts';
import type { AiProviderName } from '../ai/index.ts';
import { createAiClient } from '../ai/index.ts';
import { DaedalusEngine } from '../core/engine.ts';
import { SessionStore } from '../core/session-store.ts';
import type { SessionState } from '../core/session.ts';
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
    else if (a === '--resume') {
      const next = argv[i + 1];
      flags.resume = next && !next.startsWith('-') ? argv[++i] : '1';
    }
    else if (a === '--help') flags.help = '1';
  }
  return flags;
}

const flags = parseFlags(process.argv.slice(2));
if (flags.help) {
  console.log('daedalus — a terminal agent\n\nUsage: daedalus [--provider openai|anthropic] [--model M] [--base-url URL] [--resume [id]]\n\nConfig: ~/.daedalus/config.json and DAEDALUS_* env vars. First run starts an interactive setup.');
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

const store = new SessionStore();
let initialState: SessionState | undefined;
if (flags.resume) {
  const meta = flags.resume === '1' ? await store.latest() : { id: flags.resume };
  if (meta) {
    try {
      const loaded = await store.load(meta.id);
      initialState = { messages: loaded.messages, loadedSkills: loaded.loadedSkills };
      console.log(`${ANSI.dim}resumed session ${loaded.id} (${loaded.messages.length} messages)${ANSI.reset}`);
    } catch (e) {
      console.error(`${ANSI.red}Failed to resume: ${(e as Error).message}${ANSI.reset}`);
    }
  } else {
    console.error(`${ANSI.red}No session to resume.${ANSI.reset}`);
  }
}

console.log(`${ANSI.bold}Daedalus${ANSI.reset} — agent ready (${config.provider}${config.model ? ` / ${config.model}` : ''})`);
const engine = new DaedalusEngine({
  client,
  cwd: process.cwd(),
  initialState,
  sessionStore: store,
  maxContextTokens: base.maxContextTokens,
});
engine.subscribe(renderEvent);
await runRepl(engine);
await engine.dispose();
