import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';
import path from 'node:path';
import os from 'node:os';

try { os.networkInterfaces(); } catch { os.networkInterfaces = () => ({ lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }] }); }

export default defineConfig({
  root: path.resolve(import.meta.dirname),
  plugins: [solid()],
  server: {
    host: true,
    port: 5173,
    proxy: { '/api': { target: 'http://localhost:3100', ws: true } },
  },
  build: { outDir: path.resolve(import.meta.dirname, '../dist/web'), emptyOutDir: true },
});
