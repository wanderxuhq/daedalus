import { mkdir, readdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SessionState } from './session.ts';

export interface SessionMeta {
  id: string;
  updatedAt: string;
  messageCount: number;
}

export interface StoredSession extends SessionState {
  id: string;
  createdAt: string;
  updatedAt: string;
  cwd?: string;
}

function defaultDir(): string {
  return process.env.DAEDALUS_SESSIONS_DIR ?? join(homedir(), '.daedalus', 'sessions');
}

/** Local-time slug id: `2026-08-09T23-15-07` (sortable, unique enough). */
function makeId(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}T${p(now.getHours())}-${p(now.getMinutes())}-${p(now.getSeconds())}`;
}

/** File-backed session storage: one JSON file per session in `~/.daedalus/sessions`. */
export class SessionStore {
  private dir: string;

  constructor(dir?: string) {
    this.dir = dir ?? defaultDir();
  }

  private file(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  /** Persist a session state; returns the session id. Atomic: tmp file + rename. */
  async save(state: SessionState, meta: { id?: string; cwd?: string } = {}): Promise<string> {
    await mkdir(this.dir, { recursive: true });
    const id = meta.id ?? makeId();
    let existing: StoredSession | null = null;
    let raw: string;
    try {
      raw = await readFile(this.file(id), 'utf8');
    } catch (e) {
      const code = (e as { code?: string } | null)?.code;
      if (code !== 'ENOENT') throw e; // real IO failure, not a missing file
      raw = ''; // file does not exist yet — brand-new session (createdAt = now)
    }
    if (raw) {
      try {
        existing = JSON.parse(raw) as StoredSession;
      } catch {
        throw new Error(`Corrupt session file: ${this.file(id)}`);
      }
    }
    const now = new Date().toISOString();
    const payload: StoredSession = {
      id,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      cwd: meta.cwd ?? existing?.cwd,
      messages: state.messages,
      loadedSkills: state.loadedSkills,
    };
    const tmp = this.file(`${id}.tmp`);
    await writeFile(tmp, JSON.stringify(payload, null, 2));
    await rename(tmp, this.file(id));
    return id;
  }

  /** Load a session; throws a clear Error on a missing or corrupt file. */
  async load(id: string): Promise<StoredSession> {
    let raw: string;
    try {
      raw = await readFile(this.file(id), 'utf8');
    } catch {
      throw new Error(`Session not found: ${id}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Corrupt session file: ${this.file(id)}`);
    }
    const p = parsed as Partial<StoredSession>;
    if (!p || !Array.isArray(p.messages) || !Array.isArray(p.loadedSkills)) {
      throw new Error(`Corrupt session file: ${this.file(id)}`);
    }
    return p as StoredSession;
  }

  /** List session metadata (newest first) without reading full message bodies. */
  async list(): Promise<SessionMeta[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const metas: SessionMeta[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -'.json'.length);
      try {
        const p = JSON.parse(await readFile(this.file(id), 'utf8')) as Partial<StoredSession>;
        metas.push({
          id,
          updatedAt: p.updatedAt ?? '',
          messageCount: Array.isArray(p.messages) ? p.messages.length : 0,
        });
      } catch {
        // Skip unreadable/corrupt files; they surface only on explicit load().
      }
    }
    metas.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    return metas;
  }

  async latest(): Promise<SessionMeta | null> {
    const metas = await this.list();
    return metas[0] ?? null;
  }

  async remove(id: string): Promise<void> {
    await rm(this.file(id), { force: true });
  }
}
