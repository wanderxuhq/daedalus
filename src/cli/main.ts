#!/usr/bin/env node
import readline from 'node:readline/promises';
import { loadConfig } from '../config/config.ts';
import { createAiClient } from '../ai/index.ts';
import { tools } from '../tools/registry.ts';
import { runRepl } from './repl.ts';
import { ANSI } from './render.ts';

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
  console.log('daedalus — a terminal agent\n\nUsage: daedalus [--provider openai|anthropic] [--model M] [--base-url URL]\n\nConfig: ~/.daedalus/config.json and DAEDALUS_* env vars.');
  process.exit(0);
}

const base = loadConfig();
const config = {
  provider: (flags.provider ?? base.provider) as 'openai' | 'anthropic',
  apiKey: base.apiKey,
  baseURL: flags.baseUrl ?? base.baseURL,
  model: flags.model ?? base.model,
};
const client = createAiClient(config);
const askPermission = async (action: string, target: string): Promise<boolean> => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${ANSI.yellow}Allow ${action}? ${target} [y/n] ${ANSI.reset}`)).trim().toLowerCase();
  rl.close();
  return answer === 'y' || answer === 'yes';
};

console.log(`${ANSI.bold}Daedalus${ANSI.reset} — agent ready (${config.provider}${config.model ? ` / ${config.model}` : ''})`);
await runRepl({ client, tools, cwd: process.cwd(), askPermission });
