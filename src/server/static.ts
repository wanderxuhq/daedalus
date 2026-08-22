import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * 静态目录解析：源码形态（src/server/static.ts）→ <root>/web；编译产物（dist/server/static.js）
 * → <root>/dist/web。anther 用单一 '../web'（其 server/ 在仓库根，产物 ../web 恰为 dist/web）；
 * daedalus 的模块深两层，需按形态区分：路径含 dist 段 → 产物，取 ../web；否则源码，取 ../../web。
 */
export function staticDirFor(moduleUrl: string): string {
  const dir = path.dirname(fileURLToPath(moduleUrl));
  const isDist = path.basename(dir) === 'server' && path.basename(path.dirname(dir)) === 'dist';
  return path.resolve(dir, isDist ? '../web' : '../../web');
}

/** 第一个非回环 IPv4；取不到返回 null（启动日志专用，绝不能带崩进程）。 */
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
