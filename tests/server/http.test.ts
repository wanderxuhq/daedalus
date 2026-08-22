// tests/server/http.test.ts
// 集成测试：动态路由 JSON、404、静态 + SPA fallback、body 大小上限。
// 静态目录用临时目录，端口用 0（随机分配）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// node:http 没有 fetch 导出 —— 直接用全局 fetch 请求 http://127.0.0.1:<port>
import { HttpServer } from '../../src/server/http.ts';

async function withServer(
  setup: (h: HttpServer) => void,
  fn: (base: string) => Promise<void>,
) {
  const dir = mkdtempSync(join(tmpdir(), 'dae-http-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>dae</title>');
  writeFileSync(join(dir, 'app.js'), 'console.log(1)');
  const http = new HttpServer({ staticDir: dir });
  setup(http);
  await http.listen(0, '127.0.0.1');
  const { port } = http.address() as { port: number };
  const base = `http://127.0.0.1:${port}`;
  try {
    await fn(base);
  } finally {
    await http.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('route handlers return JSON with res.json', async () => {
  await withServer((h) => {
    h.get('/api/hello', () => ({ hi: 'there' }));
  }, async (base) => {
    const res = await fetch(`${base}/api/hello`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { hi: 'there' });
  });
});

test('unknown /api route -> 404 JSON', async () => {
  await withServer(() => {}, async (base) => {
    const res = await fetch(`${base}/api/nope`);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'not found' });
  });
});

test('static files served + SPA fallback to index.html', async () => {
  await withServer(() => {}, async (base) => {
    const js = await fetch(`${base}/app.js`);
    assert.equal(js.status, 200);
    assert.equal(await js.text(), 'console.log(1)');
    const spa = await fetch(`${base}/some/deep/path`);
    assert.equal(spa.status, 200);
    assert.match(await spa.text(), /dae/);
  });
});

test('request body is JSON-parsed with 1MB cap', async () => {
  await withServer((h) => {
    h.post('/api/echo', (_req, body) => ({ body }));
  }, async (base) => {
    const ok = await fetch(`${base}/api/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ a: 1 }),
    });
    assert.deepEqual(await ok.json(), { body: { a: 1 } });
    const tooBig = await fetch(`${base}/api/echo`, {
      method: 'POST',
      body: JSON.stringify({ big: 'x'.repeat(2_000_000) }),
    });
    assert.equal(tooBig.status, 413);
  });
});
