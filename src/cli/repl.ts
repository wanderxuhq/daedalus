import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { runAgent } from '../agent/loop.ts';
import type { Tool } from '../tools/types.ts';
import type { AiClient } from '../ai/types.ts';
import { ANSI, renderEvent } from './render.ts';

export interface ReplOpts {
  client: AiClient;
  tools: Tool[];
  cwd: string;
  askPermission: (action: string, target: string) => Promise<boolean>;
}

export async function runRepl(opts: ReplOpts): Promise<void> {
  const rl = readline.createInterface({ input, output, prompt: `${ANSI.green}›${ANSI.reset} ` });
  rl.prompt();
  let buffer = '';
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed === '/exit' || trimmed === '/quit') break;
    if (trimmed === '/help') {
      console.log('Commands: /help, /exit. Type a prompt; blank line submits multi-line input.');
      rl.prompt();
      continue;
    }
    if (trimmed === '/run' || buffer) {
      if (trimmed === '/run' && !buffer) { rl.prompt(); continue; }
      const prompt = buffer ? `${buffer}\n${trimmed === '/run' ? '' : trimmed}` : trimmed;
      buffer = '';
      console.log(ANSI.blue + '— running —' + ANSI.reset);
      try {
        await runAgent({ client: opts.client, systemPrompt: 'You are Daedalus, a terminal agent.', prompt, tools: opts.tools, cwd: opts.cwd, askPermission: opts.askPermission, onEvent: renderEvent });
      } catch (e) {
        console.error(ANSI.red + `error: ${(e as Error).message}` + ANSI.reset);
      }
      console.log();
      rl.prompt();
      continue;
    }
    // accumulating multi-line input
    buffer = trimmed;
    rl.prompt();
  }
  rl.close();
}
