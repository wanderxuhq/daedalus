import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { runSetupWizard } from '../../src/cli/setup.ts';

/**
 * Drive the wizard with canned answers; capture output; keep config in a tmp dir.
 * Answers are written upfront into a PassThrough (never ended) — the wizard's
 * own line reader consumes them, so no readline flow-control quirks apply.
 * Answer order: base URL, [API-format answer if the URL is ambiguous], API key, model.
 */
function harness(answers: string[], opts: { prewrite?: Record<string, unknown>; defaultProvider?: 'openai' | 'anthropic' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dae-setup-'));
  const configPath = join(dir, 'config.json');
  if (opts.prewrite) writeFileSync(configPath, JSON.stringify(opts.prewrite));
  const input = new PassThrough();
  for (const a of answers) input.write(`${a}\n`);
  const chunks: Buffer[] = [];
  const output = new Writable({
    write(c, _enc, cb) {
      chunks.push(Buffer.from(c));
      cb();
    },
  });
  const promise = runSetupWizard({ input, output, configPath, defaultProvider: opts.defaultProvider });
  return {
    promise,
    configPath,
    dir,
    text: () => Buffer.concat(chunks).toString('utf8'),
  };
}

test('wizard writes config.json for the entered base URL, key and model', async () => {
  // localhost URL is ambiguous → format question asked first (answer '1' = OpenAI-compatible).
  const h = harness(['http://localhost:11434/v1', '1', 'sk-test-123', 'gpt-4o-mini']);
  const cfg = await h.promise;
  assert.ok(cfg);
  assert.equal(cfg!.provider, 'openai'); // non-Anthropic URL → OpenAI-compatible
  assert.equal(cfg!.apiKey, 'sk-test-123');
  assert.equal(cfg!.baseURL, 'http://localhost:11434/v1');
  assert.equal(cfg!.model, 'gpt-4o-mini');
  const written = JSON.parse(readFileSync(h.configPath, 'utf8')) as Record<string, string>;
  assert.equal(written.provider, 'openai');
  assert.equal(written.apiKey, 'sk-test-123');
  assert.equal(written.baseURL, 'http://localhost:11434/v1');
  assert.equal(written.model, 'gpt-4o-mini');
  assert.match(h.text(), /first-time setup/);
  assert.match(h.text(), /Saved/);
  rmSync(h.dir, { recursive: true, force: true });
});

test('wizard infers anthropic provider from an api.anthropic.com base URL', async () => {
  const h = harness(['https://api.anthropic.com', 'sk-ant-1', '']);
  const cfg = await h.promise;
  assert.ok(cfg);
  assert.equal(cfg!.provider, 'anthropic');
  assert.equal(cfg!.baseURL, 'https://api.anthropic.com');
  const written = JSON.parse(readFileSync(h.configPath, 'utf8')) as Record<string, string>;
  assert.equal(written.provider, 'anthropic');
  assert.equal(written.baseURL, 'https://api.anthropic.com');
  rmSync(h.dir, { recursive: true, force: true });
});

test('wizard asks a format question for an ambiguous URL and honors an Anthropic answer', async () => {
  const h = harness(['https://gateway.example.com/v1', '2', 'sk-ant-1', '']);
  const cfg = await h.promise;
  assert.ok(cfg);
  assert.equal(cfg!.provider, 'anthropic');
  assert.match(h.text(), /API format/);
  rmSync(h.dir, { recursive: true, force: true });
});

test('wizard infers openai from a URL naming openai without asking', async () => {
  const h = harness(['https://api.openai.com/v1', 'sk-openai-1', '']);
  const cfg = await h.promise;
  assert.ok(cfg);
  assert.equal(cfg!.provider, 'openai');
  assert.doesNotMatch(h.text(), /API format/);
  rmSync(h.dir, { recursive: true, force: true });
});

test('wizard aborts without writing when the key is blank', async () => {
  const h = harness(['', '']);
  const cfg = await h.promise;
  assert.equal(cfg, null);
  assert.equal(existsSync(h.configPath), false);
  assert.match(h.text(), /No key entered/);
  rmSync(h.dir, { recursive: true, force: true });
});

test('wizard preserves existing file fields left blank', async () => {
  const h = harness(['', 'sk-new', ''], { prewrite: { provider: 'openai', baseURL: 'http://x.local' } });
  const cfg = await h.promise;
  assert.ok(cfg);
  assert.equal(cfg!.provider, 'openai'); // blank base URL → existing provider
  assert.equal(cfg!.apiKey, 'sk-new');
  assert.equal(cfg!.baseURL, 'http://x.local');
  const written = JSON.parse(readFileSync(h.configPath, 'utf8')) as Record<string, string>;
  assert.equal(written.provider, 'openai');
  assert.equal(written.baseURL, 'http://x.local');
  rmSync(h.dir, { recursive: true, force: true });
});

test('wizard defaults to defaultProvider when the base URL is blank', async () => {
  const h = harness(['', 'sk-openai-1', ''], { defaultProvider: 'openai' });
  const cfg = await h.promise;
  assert.ok(cfg);
  assert.equal(cfg!.provider, 'openai');
  rmSync(h.dir, { recursive: true, force: true });
});
