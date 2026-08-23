import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Memory file name, Claude Code's CLAUDE.md analogue. */
export const MEMORY_FILE = 'DAEDALUS.md';

export interface LoadedMemory {
  /** Paths actually read, in precedence order (user first, project last). */
  sources: string[];
  /** Concatenated contents, user memory then project memory. */
  text: string;
}

/**
 * Load durable project memory for the agent's system prompt:
 * - `~/.daedalus/DAEDALUS.md` — the user's global conventions (lowest precedence);
 * - the nearest `DAEDALUS.md` walking up from `cwd` — the project's conventions
 *   (highest precedence; like CLAUDE.md, the closest file wins).
 *
 * Project memory overrides user memory when they conflict (project text comes
 * last). Files are read once at engine construction; the text is part of the
 * system prompt, so it is constant for the whole session — and stable across
 * requests, which keeps prompt-cache prefixes intact.
 */
export function loadMemory(cwd: string, opts: { userDir?: string } = {}): LoadedMemory {
  const sources: string[] = [];
  const parts: string[] = [];

  const userFile = join(opts.userDir ?? join(homedir(), '.daedalus'), MEMORY_FILE);
  if (existsSync(userFile)) {
    sources.push(userFile);
    parts.push(readFileSync(userFile, 'utf8'));
  }

  let dir = cwd;
  while (true) {
    const candidate = join(dir, MEMORY_FILE);
    if (existsSync(candidate)) {
      sources.push(candidate);
      parts.push(readFileSync(candidate, 'utf8'));
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break; // hit the filesystem root
    dir = parent;
  }

  return { sources, text: parts.join('\n\n') };
}
