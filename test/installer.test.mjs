import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { activateDesktopProfile, desktopGateway, prepareDesktopRestore } from '../src/desktop-launch.mjs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { getAdditionalModels, getHarnessStrategy, getSavedToken, harnesses, launchAgent, prepareRestoration, saveAdditionalModels, saveHarnessStrategy, verifyGateway } from '../src/installer.mjs';
import { marketplaceLinks } from '../src/marketplace.mjs';
import { fetchModelCatalog, modelsForHarness, searchModels } from '../src/models.mjs';

const exec = promisify(execFile);
const bin = fileURLToPath(new URL('../install.mjs', import.meta.url));
const token = 'fake-api-hub-key';

test('marketplace assistant links to each matching APIHub task', () => {
  const links = marketplaceLinks('Где подключить MCP и создать агента?');
  assert.deepEqual(links.map((link) => link.split('\n').at(-1)), [
    'https://hub.gnzs.pro/app/connectors',
    'https://hub.gnzs.pro/app/tools',
    'https://hub.gnzs.pro/app/agents',
  ]);
  assert.match(marketplaceLinks('Где посмотреть мой ключ APIHub?').join('\n'), /\/app\/keys/);
  assert.match(marketplaceLinks('Хочу стать поставщиком').join('\n'), /\/app\/onboarding/);
  assert.match(marketplaceLinks('').join('\n'), /\/app\/spend/);
});

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'apihub-installer-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APIHUB_TOKEN: token,
    APIHUB_SKIP_GATEWAY_CHECK: '1',
    APIHUB_DESKTOP_PROFILE: join(home, 'desktop-profile.json'),
  };
  const run = (...args) => exec(process.execPath, [bin, ...args], { env, timeout: 10_000 });
  return { home, env, run };
}

test('the same saved list configures compatible models and keeps Auto selected', {
  skip: process.platform === 'win32',
}, async (t) => {
  const { home, env, run } = await fixture(t);
  env.APIHUB_KEY_FILE = join(home, 'credentials.json');
  const before = process.env.APIHUB_KEY_FILE;
  process.env.APIHUB_KEY_FILE = env.APIHUB_KEY_FILE;
  t.after(() => {
    if (before === undefined) delete process.env.APIHUB_KEY_FILE;
    else process.env.APIHUB_KEY_FILE = before;
  });
  const deepseek = { id: 'deepseek-v4.1-flash', name: 'DeepSeek Flash', maker: 'DeepSeek', paths: ['/chat/completions', '/messages'] };
  const glm = { id: 'glm-5.3', name: 'GLM 5.3', maker: 'Z.ai', paths: ['/chat/completions'] };
  const sonnet = { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', maker: 'Anthropic', paths: ['/messages'] };
  assert.equal(await getAdditionalModels(), undefined);
  await saveAdditionalModels([deepseek, glm, sonnet, deepseek]);
  assert.deepEqual((await getAdditionalModels()).map(({ id }) => id), [deepseek.id, glm.id, sonnet.id]);

  const binDir = join(home, 'bin');
  await mkdir(binDir);
  env.PATH = [binDir, env.PATH].join(delimiter);
  await writeFile(join(binDir, 'claude'), '#!/bin/sh\nnode -e \'const s=JSON.parse(require("node:fs").readFileSync(process.env.CLAUDE_CONFIG_DIR+"/settings.json"));console.log(JSON.stringify(s.modelPicker))\'\n', { mode: 0o700 });
  await writeFile(join(binDir, 'opencode'), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 2.4.0; else node -e \'console.log(process.env.OPENCODE_CONFIG_CONTENT)\'; fi\n', { mode: 0o700 });

  env.APIHUB_AGENT = 'claude-code';
  const claude = JSON.parse((await run()).stdout);
  assert.deepEqual(claude.options.map(({ model }) => model), ['apihub-auto', deepseek.id, sonnet.id]);
  env.APIHUB_AGENT = 'opencode';
  const openCode = JSON.parse((await run()).stdout);
  assert.equal(openCode.model, 'apihub-auto/apihub-auto');
  assert.deepEqual(Object.keys(openCode.providers['apihub-auto'].models), ['apihub-auto', deepseek.id, glm.id]);
  env.APIHUB_AGENT = 'claude-desktop';
  const desktop = await run();
  assert.match(desktop.stdout, /Пропущены в профиле · glm-5\.3/);
  const profile = () => readFile(env.APIHUB_DESKTOP_PROFILE, 'utf8').then(JSON.parse);
  const deepseekAlias = 'claude-apihub-' + Buffer.from(deepseek.id).toString('hex');
  const entries = (await profile()).inferenceModels;
  assert.deepEqual(entries.map(({ name }) => name), ['claude-fable-5', deepseekAlias, sonnet.id]);
  assert.equal(entries[1].labelOverride, deepseek.name);
  assert.equal(entries[1].behavesAs, 'claude-haiku-4-5');
  await saveAdditionalModels([deepseek]);
  await run();
  assert.deepEqual((await profile()).inferenceModels.map(({ name }) => name), ['claude-fable-5', deepseekAlias]);
});

test('model catalog searches slugs and names and keeps active native protocols', async (t) => {
  const server = createServer((_req, res) => res.end(JSON.stringify({ data: [
    { key: 'deepseek-v4.1-flash', name: 'DeepSeek Flash', type: 'chat', path: '/g/v1/chat/completions', protocols: ['chat_completions', 'messages'], offers: [{}] },
    { key: 'glm-5.3', name: 'GLM 5.3', type: 'chat', path: '/g/v1/chat/completions', offers: [{}] },
    { key: 'old-deepseek', type: 'chat', path: '/g/v1/chat/completions', protocols: ['chat_completions'], offers: [{ unavailable: 'offline' }] },
  ] })));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((done) => server.close(done)));
  const catalog = await fetchModelCatalog(`http://127.0.0.1:${server.address().port}/models`);
  assert.deepEqual(searchModels(catalog, 'dEeP fl').map(({ id }) => id), ['deepseek-v4.1-flash']);
  assert.deepEqual(searchModels(catalog, '5.3').map(({ id }) => id), ['glm-5.3']);
  assert.deepEqual(modelsForHarness(catalog, { value: 'claude-code', endpoint: '/messages' }).map(({ id }) => id), ['deepseek-v4.1-flash']);
});

test('npm bin launches the selected agent without rewriting its normal config', async (t) => {
  const { home, env, run } = await fixture(t);
  const claudeDir = join(home, '.claude');
  const original = JSON.stringify({ permissions: { defaultMode: 'default' }, env: { ANTHROPIC_CUSTOM_HEADERS: 'X-Example: keep' } });
  await mkdir(claudeDir, { recursive: true });
  await writeFile(join(claudeDir, 'settings.json'), original);

  const codexDir = join(home, '.codex');
  const codexConfig = 'model = "existing-model"\n';
  await mkdir(codexDir, { recursive: true });
  await writeFile(join(codexDir, 'config.toml'), codexConfig);

  env.APIHUB_AGENT = 'claude-desktop';
  const first = await run();
  const settingsPath = join(claudeDir, 'settings.json');
  const desktopPath = env.APIHUB_DESKTOP_PROFILE;
  const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
  const profileText = await readFile(desktopPath, 'utf8');
  const profile = JSON.parse(profileText);
  assert.deepEqual(settings, JSON.parse(original));
  assert.deepEqual(profile.inferenceModels, [{
    name: 'claude-fable-5', labelOverride: 'APIHub Auto', anthropicFamilyTier: 'fable', isFamilyDefault: true,
  }]);
  assert.equal(profile.inferenceGatewayBaseUrl, 'https://g.gnzs.pro/g/v1/claude-desktop');
  assert.equal(profile.inferenceGatewayAuthScheme, 'bearer');
  assert.equal(profile.inferenceGatewayApiKey, token);
  assert.equal(profile.modelDiscoveryEnabled, false);
  assert.ok(!first.stdout.includes(token));
  assert.match(first.stdout, /Профиль Claude Desktop (создан|уже актуален)/i);
  assert.doesNotMatch(first.stdout, /Codex/);
  if (process.platform !== 'win32') assert.equal((await stat(desktopPath)).mode & 0o777, 0o600);

  const second = await run();
  assert.match(second.stdout, /Профиль Claude Desktop (создан|уже актуален)/i);
  assert.equal(await readFile(settingsPath, 'utf8'), original);
  assert.equal(await readFile(join(codexDir, 'config.toml'), 'utf8'), codexConfig);

  env.APIHUB_STRATEGY = 'reliable';
  await run();
  assert.deepEqual(JSON.parse(await readFile(desktopPath, 'utf8')).inferenceCustomHeaders, {
    'X-APIHub-Strategy': 'reliable',
  });
});

test('saved APIHub key is reusable without reading or changing Codex', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'apihub-key-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const keyFile = join(home, 'credentials.json');
  const previous = process.env.APIHUB_KEY_FILE;
  process.env.APIHUB_KEY_FILE = keyFile;
  try {
    const { saveToken } = await import('../src/installer.mjs');
    await saveToken('saved-test-key');
    assert.equal(await getSavedToken(), 'saved-test-key');
    if (process.platform !== 'win32') assert.equal((await stat(keyFile)).mode & 0o777, 0o600);
  } finally {
    if (previous === undefined) delete process.env.APIHUB_KEY_FILE;
    else process.env.APIHUB_KEY_FILE = previous;
  }
});

test('routing modes are saved separately for each harness', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'apihub-modes-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const previous = process.env.APIHUB_KEY_FILE;
  process.env.APIHUB_KEY_FILE = join(home, 'credentials.json');
  t.after(() => {
    if (previous === undefined) delete process.env.APIHUB_KEY_FILE;
    else process.env.APIHUB_KEY_FILE = previous;
  });
  const pi = harnesses.find(({ value }) => value === 'pi');
  const codex = harnesses.find(({ value }) => value === 'codex');
  assert.equal(await getHarnessStrategy(pi), 'optimal');
  await Promise.all([saveHarnessStrategy(pi, 'cheaper'), saveHarnessStrategy(codex, 'reliable')]);
  assert.equal(await getHarnessStrategy(pi), 'cheaper');
  assert.equal(await getHarnessStrategy(codex), 'reliable');
  await assert.rejects(stat(process.env.APIHUB_KEY_FILE), { code: 'ENOENT' });
});

test('npm bin registers and selects APIHub Auto in OpenCode without an existing APIHub provider', {
  skip: process.platform === 'win32',
}, async (t) => {
  const { home, env, run } = await fixture(t);
  const config = join(home, 'config', 'opencode');
  const binDir = join(home, 'bin');
  const report = join(home, 'launch.json');
  await mkdir(config, { recursive: true });
  await mkdir(binDir);
  const original = '{ /* existing JSONC settings */ "model": "existing/model" }';
  const configPath = join(config, 'opencode.jsonc');
  await writeFile(configPath, original);
  await writeFile(join(binDir, 'opencode'), `#!/usr/bin/env node
if (process.argv[2] === '--version') {
  console.log(process.env.TEST_OPENCODE_VERSION);
} else {
  const fs = require('node:fs');
  fs.writeFileSync(process.env.TEST_REPORT, JSON.stringify({
    args: process.argv.slice(2),
    settings: JSON.parse(process.env.OPENCODE_CONFIG_CONTENT),
    keyAvailable: process.env.APIHUB_TOKEN === 'fake-api-hub-key',
  }));
}
`, { mode: 0o700 });
  Object.assign(env, {
    PATH: [binDir, env.PATH].join(delimiter),
    APIHUB_AGENT: 'opencode',
    APIHUB_STRATEGY: 'reliable',
    XDG_CONFIG_HOME: join(home, 'config'),
    OPENCODE_CONFIG_CONTENT: '{"theme":"existing","provider":{"existing":{"name":"existing"}}}',
    TEST_OPENCODE_VERSION: 'opencode v1.0.107',
    TEST_REPORT: report,
  });

  const result = await run();
  const launched = JSON.parse(await readFile(report, 'utf8'));
  assert.deepEqual(launched.args, ['--model', 'apihub-auto/apihub-auto']);
  assert.equal(launched.settings.theme, 'existing');
  assert.deepEqual(launched.settings.provider.existing, { name: 'existing' });
  assert.deepEqual(launched.settings.provider['apihub-auto'].models, {
    'apihub-auto': { name: 'APIHub Auto', tool_call: true },
  });
  assert.equal(launched.settings.provider['apihub-auto'].options.headers['X-APIHub-Strategy'], 'reliable');
  assert.equal(launched.keyAvailable, true);
  assert.ok(!JSON.stringify(launched.settings).includes(token));
  assert.ok(!result.stdout.includes(token));
  assert.equal(await readFile(configPath, 'utf8'), original);

  env.TEST_OPENCODE_VERSION = 'opencode v2.4.0';
  await run();
  const versionTwo = JSON.parse(await readFile(report, 'utf8'));
  assert.deepEqual(versionTwo.args, ['--standalone']);
  assert.equal(versionTwo.settings.model, 'apihub-auto/apihub-auto');
  assert.equal(versionTwo.settings.providers['apihub-auto'].headers['X-APIHub-Strategy'], 'reliable');
  assert.equal(versionTwo.keyAvailable, true);
  assert.equal(await readFile(configPath, 'utf8'), original);
});

test('headless launch rejects unsupported harnesses before storing a key', async (t) => {
  const { home, env, run } = await fixture(t);
  env.APIHUB_KEY_FILE = join(home, 'credentials.json');
  for (const agent of ['antigravity', 'chatgpt-desktop']) {
    env.APIHUB_AGENT = agent;
    await assert.rejects(run(), { stderr: /Antigravity|ChatGPT Desktop/ });
  }
  await assert.rejects(stat(env.APIHUB_KEY_FILE), { code: 'ENOENT' });
});

test('Claude Code launch uses a temporary profile and removes it after exit', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'apihub-session-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const claudeDir = join(home, '.claude');
  const binDir = join(home, 'bin');
  await mkdir(claudeDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  const permissions = {
    defaultMode: 'default',
    allow: ['Bash(npm test:*)', 'Bash(./vendor/bin/*:*)', 'Bash(rm -rf /private/tmp/*:*)', 'Write(//private/tmp/**)', 'Edit(src/**)'],
    deny: ['Edit(//private/tmp/secrets/**)'],
    ask: ['Bash(git push:*)'],
  };
  const original = JSON.stringify({ permissions }) + '\n';
  await writeFile(join(claudeDir, 'settings.json'), original);
  const report = join(home, 'session-report.json');
  const fake = join(binDir, 'claude');
  await writeFile(fake, `#!/bin/sh\nnode -e 'const fs=require("fs"); const p=process.env.CLAUDE_CONFIG_DIR+"/settings.json"; const settings=JSON.parse(fs.readFileSync(p)); fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify({ settings, args: process.argv.slice(1), contextWindow: process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS }));' -- "$@"\n`, { mode: 0o700 });
  const previous = process.env.HOME;
  const previousPath = process.env.PATH;
  process.env.HOME = home;
  process.env.PATH = `${binDir}:${previousPath}`;
  try {
    const result = await launchAgent('claude-code', 'session-key', { strategy: 'cheaper' });
    assert.equal(result.code, 0);
    const { settings: session, args, contextWindow } = JSON.parse(await readFile(report, 'utf8'));
    assert.equal(session.model, 'apihub-auto');
    assert.deepEqual(args, ['--model', 'apihub-auto']);
    assert.equal(session.env.ANTHROPIC_AUTH_TOKEN, 'session-key');
    assert.equal(contextWindow, '65536');
    assert.deepEqual(session.permissions, { ...permissions, allow: ['Bash(npm test:*)', 'Edit(src/**)'] });
    assert.equal(await readFile(join(claudeDir, 'settings.json'), 'utf8'), original);
  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
    process.env.PATH = previousPath;
  }
});

test('npm bin refuses an existing Desktop profile before changing Claude Code', async (t) => {
  const { home, env, run } = await fixture(t);
  const claudeDir = join(home, '.claude');
  const original = '{"model":"keep-existing"}\n';
  await mkdir(claudeDir, { recursive: true });
  await writeFile(join(claudeDir, 'settings.json'), original);
  await writeFile(env.APIHUB_DESKTOP_PROFILE, '{"managed":"leave-alone"}\n');
  env.APIHUB_AGENT = 'claude-desktop';
  await assert.rejects(run(), { stderr: /Claude Desktop profile already exists/ });
  assert.equal(await readFile(join(claudeDir, 'settings.json'), 'utf8'), original);
  assert.equal(await readFile(env.APIHUB_DESKTOP_PROFILE, 'utf8'), '{"managed":"leave-alone"}\n');
  assert.deepEqual((await readdir(claudeDir)), ['settings.json']);
});

test('a timed-out helper is stopped and its temporary profile is removed', {
  skip: process.platform === 'win32',
}, async (t) => {
  const { home, env } = await fixture(t);
  const binDir = join(home, 'bin');
  const report = join(home, 'helper-profile');
  await mkdir(binDir);
  await writeFile(join(binDir, 'claude'), '#!/bin/sh\ntrap "" TERM\nprintf "%s" "$CLAUDE_CONFIG_DIR" > "$TEST_REPORT"\nsleep 30\n', { mode: 0o700 });
  const installer = new URL('../src/installer.mjs', import.meta.url).href;
  const program = `import { launchAgent } from ${JSON.stringify(installer)};
    const result = await launchAgent('claude-code', 'fixture-key', { args: ['-p', 'test'], timeoutMs: 250 });
    console.log(JSON.stringify(result));`;
  const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', program], {
    env: { ...env, PATH: [binDir, env.PATH].join(delimiter), TEST_REPORT: report },
    timeout: 6000,
  });
  assert.deepEqual(JSON.parse(stdout), { code: null, signal: 'SIGKILL', timedOut: true });
  await assert.rejects(stat(await readFile(report, 'utf8')), { code: 'ENOENT' });
});

test('gateway preflight distinguishes a rejected key from an unavailable route', async (t) => {
  const server = createServer((req, res) => {
    if (req.url === '/unauthorized/models') return res.writeHead(401).end();
    if (req.url === '/unavailable/models') return res.writeHead(503).end();
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":[]}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const env = process.env.APIHUB_GATEWAY;
  try {
    process.env.APIHUB_GATEWAY = base + '/ok';
    await verifyGateway(token);
    process.env.APIHUB_GATEWAY = base + '/unauthorized';
    await assert.rejects(verifyGateway(token), { message: /rejected this key.*401/ });
    process.env.APIHUB_GATEWAY = base + '/unavailable';
    await assert.rejects(verifyGateway(token), { message: /route\/provider is unavailable.*503/ });
  } finally {
    if (env === undefined) delete process.env.APIHUB_GATEWAY;
    else process.env.APIHUB_GATEWAY = env;
  }
});

test('Desktop applies and reuses APIHub Auto while preserving unrelated profiles', async (t) => {
  const { home } = await fixture(t);
  const library = join(home, 'Claude-3p', 'configLibrary');
  const meta = join(library, '_meta.json');
  const existing = { appliedId: 'existing', entries: [{ id: 'existing', name: 'Existing' }], keep: true };
  await mkdir(library, { recursive: true });
  await writeFile(meta, JSON.stringify(existing));
  const old = join(library, 'existing.json');
  await writeFile(old, '{"keep":"profile"}');
  await mkdir(join(home, 'Claude'));
  const settingsPath = join(home, 'Claude', 'claude_desktop_config.json');
  await writeFile(settingsPath, '{"theme":"dark","deploymentMode":"1p"}');

  assert.equal(await activateDesktopProfile(token, home), true);
  const updated = JSON.parse(await readFile(meta, 'utf8'));
  assert.equal(updated.keep, true);
  assert.deepEqual(updated.entries[0], existing.entries[0]);
  assert.equal(updated.entries[1].name, 'APIHub Auto');
  assert.equal(updated.entries[1].id, updated.appliedId);
  const profile = JSON.parse(await readFile(join(library, updated.appliedId + '.json'), 'utf8'));
  assert.equal(profile.inferenceGatewayBaseUrl, desktopGateway);
  assert.equal(profile.inferenceGatewayApiKey, token);
  assert.deepEqual(JSON.parse(await readFile(settingsPath, 'utf8')), { theme: 'dark', deploymentMode: '3p' });
  assert.equal(await readFile(old, 'utf8'), '{"keep":"profile"}');
  assert.equal(await activateDesktopProfile(token, home), false);

  const restoration = await prepareDesktopRestore(home);
  assert.equal(typeof restoration.apply, 'function');
  assert.equal(await restoration.apply(), true);
  const restored = JSON.parse(await readFile(meta, 'utf8'));
  assert.equal(restored.appliedId, 'existing');
  assert.equal(restored.entries[1].name, 'APIHub Auto');
  assert.deepEqual(JSON.parse(await readFile(settingsPath, 'utf8')), { theme: 'dark', deploymentMode: '1p' });
  assert.equal(await readFile(old, 'utf8'), '{"keep":"profile"}');
});

test('Desktop leaves managed profile selection intact', async (t) => {
  const { home } = await fixture(t);
  const library = join(home, 'Claude-3p', 'configLibrary');
  await mkdir(library, { recursive: true });
  const meta = join(library, '_meta.json');
  const managed = '{"appliedId":"managed","hybridPointer":true}';
  await writeFile(meta, managed);
  await assert.rejects(activateDesktopProfile(token, home), { message: /профиль организации/ });
  assert.equal(await readFile(meta, 'utf8'), managed);
  assert.deepEqual(await readdir(library), ['_meta.json']);
});

test('npm bin launches Codex with the Auto Responses provider for this run', async (t) => {
  const { home, env, run } = await fixture(t);
  const binDir = join(home, 'bin');
  await mkdir(binDir);
  await writeFile(join(binDir, 'codex'),
    `#!/bin/sh\nnode -e 'process.stdout.write(JSON.stringify({args:process.argv.slice(1), hasKey:Boolean(process.env.APIHUB_TOKEN)}));' -- "$@"\n`,
    { mode: 0o700 });
  const config = join(home, '.codex');
  await mkdir(config);
  const original = 'model = "existing"\n';
  await writeFile(join(config, 'config.toml'), original);
  env.PATH = `${binDir}${delimiter}${env.PATH}`;
  env.APIHUB_AGENT = 'codex';
  env.APIHUB_STRATEGY = 'cheaper';
  const { stdout } = await run();
  const called = JSON.parse(stdout);
  assert.deepEqual(called.args.slice(0, 2), ['--model', 'apihub-auto']);
  assert.ok(called.args.includes('model_providers.apihub_auto.wire_api="responses"'));
  assert.ok(called.args.includes('model_providers.apihub_auto.http_headers.X-APIHub-Strategy="cheaper"'));
  assert.equal(called.hasKey, true);
  assert.ok(!stdout.includes(token));
  assert.equal(await readFile(join(config, 'config.toml'), 'utf8'), original);
});

test('restoring Codex uses the latest dated backup and keeps the current configuration', async (t) => {
  const { home } = await fixture(t);
  const dir = join(home, '.codex');
  await mkdir(dir);
  const path = join(dir, 'config.toml');
  await writeFile(path, 'model = "current"\n');
  await writeFile(path + '.bak.2026-11-23', 'model = "old"\n');
  await writeFile(path + '.bak.2026-11-24', 'model = "previous"\n');
  await writeFile(path + '.bak.unrelated', 'model = "unrelated"\n');
  const restoration = await prepareRestoration('codex', home);
  assert.match(restoration.message, /2026-11-24/);
  assert.equal(await readFile(path, 'utf8'), 'model = "current"\n');
  await restoration.apply();
  assert.equal(await readFile(path, 'utf8'), 'model = "previous"\n');
  const saved = (await readdir(dir)).find((entry) => entry.startsWith('config.toml.before-apihub-restore.'));
  assert.equal(await readFile(join(dir, saved), 'utf8'), 'model = "current"\n');
});

test('restoration reports session-only settings without touching files', async () => {
  const result = await prepareRestoration('pi');
  assert.match(result.message, /сеансу/);
  assert.equal(result.apply, undefined);
});
