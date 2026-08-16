#!/usr/bin/env node
// 一键开发模式：后端（node --watch）+ 前端（vite）同终端启动（仿 anther）。
import { spawn } from 'node:child_process';
const backendArgs = process.argv.slice(2);
const frontendArgs = ['node_modules/vite/bin/vite.js', '--config', 'web/vite.config.ts'];
const children = [];
let shuttingDown = false;
function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) { try { process.kill(-c.pid, 'SIGTERM'); } catch {} }
  setTimeout(() => process.exit(code), 500);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('SIGHUP', () => shutdown(0));
function start(label, args) {
  const c = spawn(process.execPath, args, { stdio: 'inherit', detached: true });
  c.on('exit', (code) => {
    if (!shuttingDown && code !== 0) { console.error(`[dev] ${label} 退出（code ${code}），联动关闭另一进程`); shutdown(code ?? 1); }
  });
  children.push(c);
  return c;
}
start('backend', ['--watch', '--experimental-transform-types', 'src/server/server.ts', ...backendArgs]);
start('frontend', frontendArgs);
