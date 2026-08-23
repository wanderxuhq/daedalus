import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Static directory resolution: source form (src/server/static.ts) → <root>/web;
 * compiled output (dist/server/static.js) → <root>/dist/web. anther uses a single
 * '../web' (its server/ is at the repo root, so ../web is dist/web); daedalus's
 * module is two levels deep, so we distinguish by form: if the path contains a
 * dist segment it is compiled output (use ../web), otherwise source (use ../../web).
 */
export function staticDirFor(moduleUrl: string): string {
  const dir = path.dirname(fileURLToPath(moduleUrl));
  const isDist = path.basename(dir) === 'server' && path.basename(path.dirname(dir)) === 'dist';
  return path.resolve(dir, isDist ? '../web' : '../../web');
}

/** First non-loopback IPv4 address; returns null if none found (for startup logs only, must not crash the process). */
export function lanIPv4(): string | null {
  let interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  try {
    interfaces = os.networkInterfaces();
  } catch {
    return null;
  }
  for (const infos of Object.values(interfaces)) {
    if (!infos) continue;
    for (const info of infos) {
      if (info.family === 'IPv4' && !info.internal) return info.address;
    }
  }
  return null;
}
