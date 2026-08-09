import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { ANSI } from './render.ts';
import type { SkillInfo } from '../core/skills/types.ts';
import type { CoreEvent } from '../core/events.ts';

export interface EngineLike {
  subscribe(handler: (ev: CoreEvent) => void): () => void;
  run(prompt: string): Promise<string>;
  skills: SkillInfo[];
  loadSkill(name: string): Promise<SkillInfo>;
}

export type ReplLineResult = 'exit' | 'handled' | 'unhandled';

const RESERVED = new Set(['exit', 'quit', 'help', 'skills', 'run']);

/** Handle one line of REPL input as a command. Returns how it was handled. */
export async function handleReplLine(line: string, engine: EngineLike): Promise<ReplLineResult> {
  const trimmed = line.trim();
  if (trimmed === '/exit' || trimmed === '/quit') return 'exit';
  if (trimmed === '/help') {
    console.log('Commands: /help, /exit, /skills, /<skill-name>. Type a prompt; blank line submits multi-line input.');
    return 'handled';
  }
  if (trimmed === '/skills') {
    for (const s of engine.skills) {
      console.log(`${ANSI.bold}${s.name}${ANSI.reset}${s.userInvocable ? '' : ' (user-only)'}: ${s.description}`);
    }
    if (engine.skills.length === 0) console.log('No skills installed.');
    return 'handled';
  }
  if (trimmed.startsWith('/') && !trimmed.includes(' ') && !RESERVED.has(trimmed.slice(1))) {
    const name = trimmed.slice(1);
    try {
      const info = await engine.loadSkill(name);
      console.log(`${ANSI.green}Loaded skill ${info.name}:${ANSI.reset} ${info.description}`);
    } catch {
      console.error(`${ANSI.red}Unknown skill: ${name}${ANSI.reset}`);
    }
    return 'handled';
  }
  return 'unhandled';
}

export async function runRepl(engine: EngineLike): Promise<void> {
  const rl = readline.createInterface({ input, output, prompt: `${ANSI.green}›${ANSI.reset} ` });
  rl.prompt();
  let buffer = '';
  for await (const line of rl) {
    const result = await handleReplLine(line, engine);
    if (result === 'exit') break;
    if (result === 'handled') { rl.prompt(); continue; }
    const trimmed = line.trim();
    if (trimmed === '/run' || buffer) {
      const prompt = buffer ? `${buffer}\n${trimmed === '/run' ? '' : trimmed}` : trimmed;
      buffer = '';
      console.log(ANSI.blue + '— running —' + ANSI.reset);
      try {
        const text = await engine.run(prompt);
        console.log(ANSI.dim + text + ANSI.reset);
      } catch (e) {
        console.error(ANSI.red + `error: ${(e as Error).message}` + ANSI.reset);
      }
      console.log();
      rl.prompt();
      continue;
    }
    buffer = trimmed;
    rl.prompt();
  }
  rl.close();
}
