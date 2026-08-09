import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { Readable, Writable } from 'node:stream';
import type { AiProviderName } from '../ai/index.ts';
import type { DaedalusConfig } from '../config/config.ts';
import { ANSI } from './render.ts';

export interface SetupOptions {
  input?: Readable;
  output?: Writable;
  configPath?: string;
  defaultProvider?: AiProviderName;
}

const PROVIDER_LABEL: Record<AiProviderName, string> = { anthropic: 'Anthropic', openai: 'OpenAI' };

function readExisting(configPath: string): Partial<DaedalusConfig> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf8'));
    if (parsed && typeof parsed === 'object') return parsed as Partial<DaedalusConfig>;
  } catch {
    // No file or unreadable JSON → start fresh.
  }
  return {};
}

/**
 * Minimal prompt/line reader over a stream. Used instead of node:readline so the
 * wizard is fully testable with injected streams: readline pauses its (non-TTY)
 * input after the first line and never resumes on later questions, which hangs
 * any stream-driven test. On a real terminal the tty driver already provides
 * line editing (backspace, etc.), so nothing is lost.
 */
function createLineReader(input: Readable, output: Writable) {
  let buffer = '';
  const lines: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  const onData = (chunk: string | Buffer): void => {
    buffer += chunk.toString();
    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);
      const waiter = waiters.shift();
      if (waiter) waiter(line);
      else lines.push(line);
    }
  };
  const onEnd = (): void => {
    // Input closed mid-question → treat as an empty answer (aborts the wizard).
    for (const waiter of waiters.splice(0)) waiter('');
  };
  input.on('data', onData);
  input.on('end', onEnd);
  input.resume();
  return {
    readLine(prompt: string): Promise<string> {
      output.write(prompt);
      const ready = lines.shift();
      if (ready !== undefined) return Promise.resolve(ready);
      return new Promise((resolve) => { waiters.push(resolve); });
    },
    close(): void {
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
    },
  };
}

/**
 * First-run setup wizard. Asks for provider, API key, model and base URL and
 * writes them to the config file. Returns the resolved config, or null when
 * the user aborts (no key entered). Never throws on user input.
 */
export async function runSetupWizard(opts: SetupOptions = {}): Promise<DaedalusConfig | null> {
  // Honor DAEDALUS_CONFIG_PATH like src/config/config.ts does, so the wizard
  // writes where the runtime will look. Tests always pass configPath explicitly.
  const configPath = opts.configPath ?? process.env.DAEDALUS_CONFIG_PATH ?? join(homedir(), '.daedalus', 'config.json');
  const input = opts.input ?? process.stdin;
  const out = opts.output ?? process.stdout;
  const write = (s: string): void => { out.write(s); };
  const existing = readExisting(configPath);

  write(ANSI.bold + 'Daedalus — first-time setup' + ANSI.reset + '\n');
  write("I couldn't find an API key for your provider. Answer a few questions and I'll save the config.\n");
  write(`This writes ${ANSI.blue}${configPath}${ANSI.reset}. You can change it anytime, or set DAEDALUS_* env vars instead.\n\n`);

  const reader = createLineReader(input, out);
  try {
    const fallback = opts.defaultProvider ?? existing.provider ?? 'anthropic';
    const providerAnswer = (await reader.readLine(`Provider — 1) Anthropic  2) OpenAI  [${fallback}]: `)).trim().toLowerCase();
    const provider: AiProviderName =
      providerAnswer === '1' || providerAnswer === 'anthropic' ? 'anthropic'
      : providerAnswer === '2' || providerAnswer === 'openai' ? 'openai'
      : fallback;

    const apiKey = (await reader.readLine(`API key for ${PROVIDER_LABEL[provider]} (required): `)).trim();
    if (!apiKey) {
      write(`\nNo key entered. You can also set ${provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'} (or DAEDALUS_API_KEY) and rerun.\n`);
      return null;
    }

    const modelDefault = existing.model ? ` [${existing.model}]` : '';
    const model = (await reader.readLine(`Model (blank for ${PROVIDER_LABEL[provider]} default${modelDefault}): `)).trim() || existing.model;
    const baseURLDefault = existing.baseURL ? ` [${existing.baseURL}]` : '';
    const baseURL = (await reader.readLine(`Base URL (blank for default${baseURLDefault}): `)).trim() || existing.baseURL;

    const file: Record<string, string> = { provider, apiKey };
    if (model) file.model = model;
    if (baseURL) file.baseURL = baseURL;

    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify(file, null, 2) + '\n');
    chmodSync(configPath, 0o600);

    write(`\n${ANSI.green}Saved${ANSI.reset} ${configPath}. You're ready to go.\n`);
    return { provider, apiKey, model, baseURL };
  } finally {
    reader.close();
  }
}
