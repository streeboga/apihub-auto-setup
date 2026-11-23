import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../setup.mjs', import.meta.url));
const token = 'test-api-key';
const initial = {
  permissions: { defaultMode: 'default' },
  env: { ANTHROPIC_CUSTOM_HEADERS: 'X-Example: keep\nx-apihub-strategy: faster' },
};

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'apihub-auto-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const run = (...args) => spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: dir, APIHUB_TOKEN: token },
  });
  return { dir, path: join(dir, 'settings.json'), run };
}

test('dry run displays the gateway, virtual model and strategy without saving the key', async (t) => {
  const { dir, run } = await fixture(t);
  const result = run('--dry-run', '--strategy', 'cheaper');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /https:\/\/g\.gnzs\.pro\/g\/v1\/messages.*apihub-auto.*cheaper/);
  assert.ok(!result.stdout.includes(token));
  assert.deepEqual(await readdir(dir), []);
});

test('apply preserves unrelated settings and headers, is repeatable, and has a restore path', async (t) => {
  const { path, dir, run } = await fixture(t);
  const original = JSON.stringify(initial);
  await writeFile(path, original);
  const result = run('--apply', '--strategy', 'reliable');
  assert.equal(result.status, 0, result.stderr);
  const settings = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(settings.model, 'apihub-auto');
  assert.deepEqual(settings.permissions, initial.permissions);
  assert.equal(settings.env.ANTHROPIC_BASE_URL, 'https://g.gnzs.pro/g');
  assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, token);
  assert.equal(settings.env.ANTHROPIC_CUSTOM_MODEL_OPTION, 'apihub-auto');
  assert.equal(settings.env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME, 'APIHub Auto');
  assert.equal(settings.env.ANTHROPIC_CUSTOM_HEADERS, 'X-Example: keep\nX-APIHub-Strategy: reliable');
  assert.equal(run('--apply', '--strategy', 'reliable').status, 0);
  assert.equal((await readdir(dir)).filter((name) => name.startsWith('settings.json.bak.')).length, 1);
  assert.equal(run('--restore').status, 0);
  assert.equal(await readFile(path, 'utf8'), original);
});

test('refuses invalid options and protects invalid settings', async (t) => {
  const { dir, path, run } = await fixture(t);
  assert.equal(run('--apply', '--strategy', 'invalid').status, 1);
  assert.equal(run('--apply', '--gateway', 'http://g.gnzs.pro/g/v1').status, 1);
  assert.equal(run('--apply', '--dry-run').status, 1);
  assert.deepEqual(await readdir(dir), []);
  await writeFile(path, '{"env":[] }');
  assert.equal(run('--apply').status, 1);
  assert.equal(await readFile(path, 'utf8'), '{"env":[] }');
  assert.deepEqual(await readdir(dir), ['settings.json']);
});
