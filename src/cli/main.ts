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
import { parseFlags } from './flags.ts';
import { main as webMain } from '../server/server.ts';

const flags = parseFlags(process.argv.slice(2));
if (flags.help) {
  console.log('daedalus — a terminal agent\n\nUsage: daedalus [--provider openai|anthropic] [--model M] [--base-url URL] [--resume [id]] [--auto]\n\n--auto auto-approves tool permissions (bash/write run without y/n prompts).\nExtended thinking is ON by default; disable with DAEDALUS_THINKING=0 or "thinking": false in config.\n\nConfig: ~/.daedalus/config.json and DAEDALUS_* env vars. First run starts an interactive setup.');
  process.exit(0);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'web') {
  // main() 在 listen 成功后即 resolve（服务存活由 server handle 维持；SIGTERM/SIGINT 在
  // main 内部自行退出）。这里绝不能 process.exit —— 否则会把刚起好的服务当场杀掉。
  try {
    await webMain(rest);
  } catch (e) {
    console.error((e as Error).message ?? e);
    process.exit(1);
  }
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
let sessionId: string | undefined;
if (flags.resume) {
  const meta = flags.resume === '1' ? await store.latest() : { id: flags.resume };
  if (meta) {
    try {
      const loaded = await store.load(meta.id);
      initialState = { messages: loaded.messages, loadedSkills: loaded.loadedSkills };
      sessionId = loaded.id; // continue writing to the resumed session's file
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
  sessionId,
  sessionStore: store,
  maxContextTokens: base.maxContextTokens,
  thinking: base.thinking,
  thinkingBudgetTokens: base.thinkingBudgetTokens,
});
engine.subscribe(renderEvent);
const autoApprove = flags.auto === '1' || base.autoApprove === true;
await runRepl(engine, { autoApprove });
await engine.dispose();
