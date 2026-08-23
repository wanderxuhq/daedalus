/**
 * Minimal gitignore semantics for the grep walk — ripgrep/CC-style, covering
 * the patterns people actually use:
 *   - blank lines and `#` comments
 *   - `!` negation, `\#` / `\!` escapes
 *   - trailing `/` → directory-only
 *   - leading `/` → anchored to the .gitignore's directory
 *   - a `/` elsewhere anchors the pattern; a pattern with no `/` matches the
 *     basename at any depth (including top-level)
 *   - `*`, `?`, `**` globs
 * Deeper .gitignore files override shallower ones; within one file the last
 * matching pattern wins (git semantics).
 */

export interface GitignoreRule {
  re: RegExp;
  negated: boolean;
  dirOnly: boolean;
}

function globSource(glob: string): string {
  let s = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  // Placeholder tokens immune to the `*`/`?` replaces below, so the injected
  // regex syntax (`(?:.*/)?`, `.*`) is never mangled.
  const GLOBSTAR = '\u0000GS\u0000';
  const ANY = '\u0000ANY\u0000';
  // `**/` = zero or more path segments (a leading `**/` also matches the base
  // dir, like git's `**/foo` == `foo`); a bare `**` = any chars incl `/`.
  s = s.replace(/\*\*\//g, GLOBSTAR);
  s = s.replace(/\*\*/g, ANY);
  s = s.replace(/\*/g, '[^/]*');
  s = s.replace(/\?/g, '[^/]');
  s = s.replaceAll(GLOBSTAR, '(?:.*/)?');
  s = s.replaceAll(ANY, '.*');
  return s;
}

function parseLine(raw: string): GitignoreRule | null {
  let line = raw.trimEnd();
  if (line === '' || line.startsWith('#')) return null;
  if (line.startsWith('\\#')) line = line.slice(1);
  let negated = false;
  if (line.startsWith('!')) { negated = true; line = line.slice(1); }
  else if (line.startsWith('\\!')) { line = line.slice(1); }
  if (line === '') return null;
  let dirOnly = false;
  if (line.endsWith('/')) { dirOnly = true; line = line.slice(0, -1); }
  if (line === '') return null;
  const anchored = line.startsWith('/');
  if (anchored) line = line.slice(1);
  const source = anchored || line.includes('/')
    ? `^${globSource(line)}$`
    : `^(?:.*/)?${globSource(line)}$`; // no slash → basename at any depth
  return { re: new RegExp(source), negated, dirOnly };
}

export class GitignoreMatcher {
  private rules: GitignoreRule[] = [];

  /** Parse .gitignore file content; the last matching rule in the file wins. */
  addContent(content: string): void {
    for (const line of content.split('\n')) {
      const rule = parseLine(line);
      if (rule) this.rules.push(rule);
    }
  }

  /**
   * `relPath` is relative to the directory this .gitignore lives in.
   * Returns undefined when no rule matches (decision falls to a shallower file).
   */
  test(relPath: string, isDir: boolean): boolean | undefined {
    let ignored: boolean | undefined;
    for (const r of this.rules) {
      if (r.re.test(relPath) && (!r.dirOnly || isDir)) ignored = !r.negated;
    }
    return ignored;
  }
}

/** A matcher attached to a walked directory, keyed by its rel path from the root. */
export interface IgnoreLayer {
  /** Rel path of the directory holding the .gitignore ('' for the search root). */
  base: string;
  matcher: GitignoreMatcher;
}

/** Evaluate the stack of layers deepest-first (deeper files override shallower). */
export function isIgnored(stack: IgnoreLayer[], relPath: string, isDir: boolean): boolean {
  for (let i = stack.length - 1; i >= 0; i--) {
    const { base, matcher } = stack[i];
    const rel = base === '' ? relPath : relPath.startsWith(`${base}/`) ? relPath.slice(base.length + 1) : null;
    if (rel === null) continue;
    const decided = matcher.test(rel, isDir);
    if (decided !== undefined) return decided;
  }
  return false;
}
