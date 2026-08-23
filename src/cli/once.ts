import type { DaedalusEngine } from '../core/engine.ts';

export interface RunOnceResult {
  status: 'ok' | 'error';
  result?: string;
  error?: string;
  usage: { inputTokens: number; outputTokens: number };
}

/**
 * Single-shot run for scripts/CI (`daedalus -p "…"`): run one prompt through
 * the engine and return a structured result. Rendering is NOT this module's
 * job — the caller decides text vs JSON and subscribes a renderer itself, so
 * `-p --output-format json` keeps stdout clean for machine consumption.
 */
export async function runOnce(engine: DaedalusEngine, prompt: string): Promise<RunOnceResult> {
  try {
    const result = await engine.run(prompt);
    return { status: 'ok', result, usage: engine.usage() };
  } catch (e) {
    return { status: 'error', error: (e as Error).message, usage: engine.usage() };
  }
}
