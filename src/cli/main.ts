#!/usr/bin/env node
import { loadConfig, missingProvider } from '../config/config.ts';
import type { DaedalusConfig } from '../config/config.ts';
import type { AiProviderName } from '../ai/index.ts';
import { createAiClient } from '../ai/index.ts';
import { DaedalusEngine } from '../core/engine.ts';
import { loadMcpConfig } from '../mcp/config.ts';
import { SessionStore } from '../core/session-store.ts';
import type { SessionState } from '../core/session.ts';
import { runRepl } from './repl.ts';
import { runSetupWizard } from './setup.ts';
import { ANSI, renderEvent, streamAnswerOnly } from './render.ts';
import { parseFlags } from './flags.ts';
import { runOnce } from './once.ts';
import { main as webMain } from '../server/server.ts';

// Prevent silent crashes from stray unhandled rejections or uncaught exceptions.
// Node.js ≥ 15 exits on unhandledRejection; these handlers log the cause before dying,
// so the failure is diagnosable instead of a bare "server died" with no output.
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] unhandledRejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[FATAL] uncaughtException:', err);
});

const flags = parseFlags(process.argv.slice(2));
if (flags.help) {
  console.log('daedalus — a terminal agent\n\nUsage: daedalus [--provider openai|anthropic] [--model M] [--base-url URL] [--resume [id]] [--auto] [-p PROMPT] [--output-format text|json] [--version]\n\n--auto auto-approves tool permissions (bash/write run without y/n prompts).\n-p/--prompt runs one prompt and exits (scripts/CI); combine with --output-format json for machine-readable output.\nExtended thinking is ON by default; disable with DAEDALUS_THINKING=0 or "thinking": false in config.\n\nConfig: ~/.daedalus/config.json and DAEDALUS_* env vars. First run starts an interactive setup.');
  process.exit(0);
}
if (flags.version) {
  const { readFileSync } = await import('node:fs');
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: string };
    console.log(`daedalus ${pkg.version ?? '(unknown)'}`);
  } catch {
    console.log('daedalus (unknown version)');
  }
  process.exit(0);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'web') {
  // main() resolves once listen succeeds (server liveness is held by the handle;
  // SIGTERM/SIGINT exits inside main itself). Never process.exit here — it would
  // kill the just-started server immediately.
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
  try {
    // latest() lives OUTSIDE the load try below: a store failure (unreadable
    // sessions dir, corrupt listing) must be reported cleanly, not crash with
    // an unhandled rejection and a raw stack trace.
    const meta = flags.resume === '1' ? await store.latest() : { id: flags.resume };
    if (meta) {
      const loaded = await store.load(meta.id);
      initialState = { messages: loaded.messages, loadedSkills: loaded.loadedSkills };
      sessionId = loaded.id; // continue writing to the resumed session's file
      if (flags.prompt === undefined) console.log(`${ANSI.dim}resumed session ${loaded.id} (${loaded.messages.length} messages)${ANSI.reset}`);
    } else {
      console.error(`${ANSI.red}No sessions to resume — run a conversation first. Sessions are saved to ${store.dir} after each run; /sessions lists them.${ANSI.reset}`);
    }
  } catch (e) {
    console.error(`${ANSI.red}Failed to resume: ${(e as Error).message}${ANSI.reset}`);
  }
}

// Load MCP server configuration from ~/.daedalus/mcp.json
const mcpConfig = loadMcpConfig();

// Single-shot mode keeps stdout clean for the prompt's own output.
if (flags.prompt === undefined) {
  console.log(`${ANSI.bold}Daedalus${ANSI.reset} — agent ready (${config.provider}${config.model ? ` / ${config.model}` : ''})`);
}
const engine = new DaedalusEngine({
  client,
  cwd: process.cwd(),
  initialState,
  sessionId,
  sessionStore: store,
  maxContextTokens: base.maxContextTokens,
  thinking: base.thinking,
  thinkingBudgetTokens: base.thinkingBudgetTokens,
  model: config.model,
  mcpConfig,
  ...(base.hooks ? { hooks: base.hooks } : {}),
});
const autoApprove = flags.auto === '1' || base.autoApprove === true;

// Single-shot mode: `-p "prompt"` runs once and exits — the script/CI interface.
// `--output-format json` keeps stdout clean: exactly one JSON object on success.
if (flags.prompt !== undefined) {
  if (flags.prompt === '') {
    console.error('daedalus: -p/--prompt requires a non-empty prompt');
    process.exit(2);
  }
  const json = flags.outputFormat === 'json';
  if (flags.outputFormat !== undefined && flags.outputFormat !== 'text' && flags.outputFormat !== 'json') {
    console.error('daedalus: --output-format must be "text" or "json"');
    process.exit(2);
  }
  // Text mode streams ONLY the final answer's text deltas to stdout — no
  // thinking, no tool cards, no banner — so `-p` output is the answer alone
  // (script/CI friendly). `hasOutput()` guards the fallback: an adapter that
  // puts the answer solely in the terminal 'done' still gets it printed once.
  const answer = streamAnswerOnly();
  const unsub = json ? undefined : engine.subscribe(answer.handler);
  const res = await runOnce(engine, flags.prompt);
  unsub?.();
  if (json) {
    console.log(JSON.stringify(res));
  } else if (res.status === 'ok') {
    if (answer.hasOutput()) process.stdout.write('\n');
    else if (res.result) process.stdout.write(`${res.result}\n`);
  } else {
    console.error(`${ANSI.red}✗ ${res.error}${ANSI.reset}`);
  }
  await engine.dispose();
  process.exit(res.status === 'ok' ? 0 : 1);
}

// Interactive REPL with stream renderer.
engine.subscribe(renderEvent);
await runRepl(engine, { autoApprove });
await engine.dispose();
