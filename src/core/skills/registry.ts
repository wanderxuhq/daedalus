import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import type { SkillInfo, SkillFrontmatter } from './types.ts';

/** Small YAML-subset parser: `key: value` scalar lines. Non-scalar content is skipped. */
function parseFrontmatter(raw: string): SkillFrontmatter {
  const out: Record<string, unknown> = {};
  for (const line of raw.split('\n')) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    const key = m[1];
    const val = m[2].trim().replace(/^["']|["']$/g, '');
    if (val === '') continue;
    if (key === 'disable-model-invocation' || key === 'user-invocable') {
      out[key] = val === 'true';
    } else {
      out[key] = val;
    }
  }
  return out as SkillFrontmatter;
}

export function parseSkillDir(dir: string): SkillInfo | null {
  const mdPath = join(dir, 'SKILL.md');
  let raw: string;
  try {
    raw = readFileSync(mdPath, 'utf8');
  } catch {
    return null;
  }
  const fence = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  let fm: SkillFrontmatter = {};
  let body = raw;
  if (fence) {
    fm = parseFrontmatter(fence[1]);
    body = raw.slice(fence[0].length).trimStart();
  }
  return {
    name: fm.name ?? basename(dir),
    description: fm.description ?? '',
    whenToUse: fm.when_to_use,
    body,
    userInvocable: fm['user-invocable'] !== false,
  };
}

/** Discover `.claude/skills` in cwd and every parent up to fs root. */
function findProjectSkillDirs(cwd: string): string[] {
  const dirs: string[] = [];
  let cur = cwd;
  for (;;) {
    const candidate = join(cur, '.claude', 'skills');
    if (existsSync(candidate)) dirs.push(candidate);
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return dirs;
}

export class SkillRegistry {
  private byName = new Map<string, SkillInfo>();

  constructor(skillDirs?: string[]) {
    const dirs = skillDirs ?? [
      ...findProjectSkillDirs(process.cwd()),
      join(homedir(), '.daedalus', 'skills'),
    ];
    for (const dir of dirs) this.loadDir(dir);
  }

  private loadDir(dir: string): void {
    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const info = parseSkillDir(join(dir, e.name));
      if (!info) continue;
      if (!this.byName.has(info.name)) this.byName.set(info.name, info); // first wins
    }
  }

  get names(): string[] {
    return [...this.byName.keys()];
  }

  get(name: string): SkillInfo | undefined {
    return this.byName.get(name);
  }

  list(): SkillInfo[] {
    return [...this.byName.values()];
  }

  renderListing(maxChars: number): string {
    const lines: string[] = [];
    let total = 0;
    for (const s of this.list()) {
      const entry = `${s.name} — ${s.description}`;
      const add = lines.length === 0 ? entry.length : entry.length + 1;
      if (total + add > maxChars) continue;
      lines.push(entry);
      total += add;
    }
    return lines.join('\n');
  }
}
