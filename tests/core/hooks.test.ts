import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runHook, matchesHook, runPreToolUseHooks, DEFAULT_HOOK_TIMEOUT_MS } from '../../src/core/hooks.ts';
import { resolveConfig } from '../../src/config/config.ts';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('runHook executes a shell command and captures stdout', async () => {
  const run = await runHook('echo hello', {});
  assert.equal(run.stdout.trim(), 'hello');
  assert.equal(run.exitCode, 0);
  assert.equal(run.timedOut, false);
});

test('runHook feeds the input as JSON on stdin', async () => {
  const script = "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(d))";
  const input = { toolName: 'bash', toolInput: { command: 'ls' } };
  const run = await runHook(`node -e "${script.replace(/"/g, '\\"')}"`, input);
  assert.deepEqual(JSON.parse(run.stdout), input);
});

test('runHook kills a hanging hook after the timeout', async () => {
  const started = Date.now();
  const run = await runHook('sleep 5', {}, 100);
  assert.equal(run.timedOut, true);
  assert.ok(Date.now() - started < 2000, 'timeout must kill promptly');
});

test('runHook resolves a non-zero exit (hooks signal via exit codes, not exceptions)', async () => {
  const run = await runHook('exit 3', {});
  assert.equal(run.exitCode, 3);
  assert.equal(run.timedOut, false);
});

test('runHook default timeout is the documented constant', () => {
  assert.equal(DEFAULT_HOOK_TIMEOUT_MS, 60_000);
});

test('matchesHook tests the regex against toolName + input JSON', () => {
  assert.equal(matchesHook({ matcher: '^bash\n', command: 'x' }, 'bash', { command: 'ls' }), true);
  assert.equal(matchesHook({ matcher: '^bash\n', command: 'x' }, 'read', { path: 'a' }), false);
  assert.equal(matchesHook({ matcher: 'command.*ls', command: 'x' }, 'bash', { command: 'ls -la' }), true);
  assert.equal(matchesHook({ matcher: '(', command: 'x' }, 'bash', {}), false); // broken regex is safe
});

test('runPreToolUseHooks: JSON deny blocks with the reason', async () => {
  const decision = await runPreToolUseHooks(
    [{ matcher: '^bash\n', command: 'node -e "process.stdout.write(JSON.stringify({permissionDecision:\'deny\', reason:\'no shell today\'}))"' }],
    'bash',
    { command: 'rm -rf /' },
  );
  assert.equal(decision.denied, true);
  assert.equal(decision.reason, 'no shell today');
});

test('runPreToolUseHooks: JSON additionalContext is collected', async () => {
  const decision = await runPreToolUseHooks(
    [{ matcher: '^bash\n', command: 'node -e "process.stdout.write(JSON.stringify({additionalContext:\'repo is dirty\'}))"' }],
    'bash',
    { command: 'ls' },
  );
  assert.equal(decision.denied, false);
  assert.equal(decision.additionalContext, 'repo is dirty');
});

test('runPreToolUseHooks: non-JSON stdout becomes free-form context', async () => {
  const decision = await runPreToolUseHooks(
    [{ matcher: '^read\n', command: 'echo remember to check the lock' }],
    'read',
    { path: 'a.ts' },
  );
  assert.equal(decision.denied, false);
  assert.equal(decision.additionalContext, 'remember to check the lock');
});

test('runPreToolUseHooks: an unrecognized JSON object is still context (not silently dropped)', async () => {
  const decision = await runPreToolUseHooks(
    [{ matcher: '^edit\n', command: 'node -e "process.stdout.write(JSON.stringify({message:\'run lint after this edit\'}))"' }],
    'edit',
    { path: 'a.ts', oldString: 'x', newString: 'y' },
  );
  assert.equal(decision.denied, false);
  assert.equal(decision.additionalContext, '{"message":"run lint after this edit"}');
});

test('runPreToolUseHooks: a deny object never leaks as context', async () => {
  const decision = await runPreToolUseHooks(
    [{ matcher: '^bash\n', command: 'node -e "process.stdout.write(JSON.stringify({permissionDecision:\'deny\'}))"' }],
    'bash',
    { command: 'ls' },
  );
  assert.equal(decision.denied, true);
  assert.equal(decision.additionalContext, undefined);
});

test('runPreToolUseHooks: non-matching rules are skipped', async () => {
  const decision = await runPreToolUseHooks(
    [{ matcher: '^bash\n', command: 'echo nope' }],
    'read',
    { path: 'a.ts' },
  );
  assert.equal(decision.denied, false);
  assert.equal(decision.additionalContext, undefined);
});

test('resolveConfig reads hooks from the config file', () => {
  const dir = join(tmpdir(), `dae-cfg-hook-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const cfgPath = join(dir, 'config.json');
  writeFileSync(cfgPath, JSON.stringify({
    apiKey: 'k',
    provider: 'anthropic',
    hooks: { preToolUse: [{ matcher: '^bash\n', command: 'echo hi' }], stop: 'echo bye' },
  }));
  const cfg = resolveConfig({ DAEDALUS_CONFIG_PATH: cfgPath });
  assert.deepEqual(cfg.hooks?.preToolUse?.[0], { matcher: '^bash\n', command: 'echo hi' });
  assert.equal(cfg.hooks?.stop, 'echo bye');
  rmSync(dir, { recursive: true, force: true });
});
