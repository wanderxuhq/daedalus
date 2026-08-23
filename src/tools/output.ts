import { mkdir, writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * CC-style tool output handling: never let a tool result blow the context
 * window silently. Results over the cap are cut at the cap and the FULL output
 * is spilled to a temp file whose path is appended to the result, so the model
 * can read more on demand with the read tool.
 */
export const TOOL_OUTPUT_CAP = 30_000;

/** Every spill file created this process; removed on exit and on engine dispose. */
const spilled = new Set<string>();
// The 'exit' hook is a safety net (a hard Ctrl+C / SIGTERM skips engine
// dispose); each module load adds one listener, which is harmless (rm is
// idempotent). The real cleanup happens in engine.dispose via clearSpilledOutputs.
process.on('exit', () => { for (const f of spilled) rmSync(f, { force: true }); });

/** Delete every spilled tool-output file (engine dispose). */
export function clearSpilledOutputs(): void {
  for (const f of spilled) rmSync(f, { force: true });
  spilled.clear();
}

export interface TruncatedOutput {
  content: string;
  /** Number of characters retained (before the spill note). */
  retained: number;
}

export async function truncateResult(content: string, maxChars: number = TOOL_OUTPUT_CAP): Promise<TruncatedOutput> {
  if (content.length <= maxChars) return { content, retained: content.length };
  const dir = join(tmpdir(), 'daedalus');
  await mkdir(dir, { recursive: true });
  const file = join(dir, `tool-output-${process.pid}-${randomBytes(4).toString('hex')}.txt`);
  await writeFile(file, content, 'utf8');
  spilled.add(file);
  return {
    content: `${content.slice(0, maxChars)}\n\n[output truncated at ${maxChars} chars — full output saved to ${file}; read it with the read tool if you need more]`,
    retained: maxChars,
  };
}
