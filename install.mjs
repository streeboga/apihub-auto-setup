#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { defaultGateway, gatewayBase, replaceSettings } from './src/setup.mjs';

const release = 'https://github.com/streeboga/apihub-setup/releases/download/v0.1.0';
const checksums = {
  'darwin-arm64': '4d6a670fc46b07d5bb0ab687bfb037a36707e851d751e433ebc43f1c99a1439c',
  'darwin-x64': 'f908c12156c22c9883ae72e343f57cd1458e93101735454a8733476b3b0c97c0',
  'linux-arm64': 'a87d93c5f8c58ce17eaa972f82a88125ed6356efbb743adf0e668afefe39968e',
  'linux-x64': 'b0eddf6cdc09c6832c02260b2fa756e0519bc0b6ae348f04dde2189883f60cf2',
  'win32-x64': '6597807cec37fad107ead231df1e752df9278d94677d9669e22b557ae8806c85',
};

async function askForToken() {
  if (!process.stdin.isTTY) {
    throw new Error('Запустите установщик в терминале, чтобы ввести токен APIHub.');
  }
  const muted = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const input = createInterface({ input: process.stdin, output: muted, terminal: true, historySize: 0 });
  process.stderr.write('Вставьте токен APIHub и нажмите Enter: ');
  try {
    for await (const line of input) {
      const token = line.trim();
      if (/^[!-~]+$/.test(token)) return token;
      break;
    }
    throw new Error('Для настройки нужен токен APIHub.');
  } finally {
    input.close();
    process.stderr.write('\n');
  }
}

async function existingSettings(...parts) {
  try {
    return await realpath(join(homedir(), ...parts));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function finishClaudeCode(token) {
  const path = await existingSettings('.claude', 'settings.json');
  if (!path) return;
  const original = await readFile(path, 'utf8');
  const settings = JSON.parse(original);
  const env = settings.env;
  if (env?.ANTHROPIC_AUTH_TOKEN !== token || env.ANTHROPIC_BASE_URL !== defaultGateway) {
    throw new Error('Настройщик не подтвердил подключение Claude Code к APIHub.');
  }

  const haiku = 'claude-haiku-4.5';
  settings.model = haiku;
  // The Anthropic client appends /v1/messages to this base.
  env.ANTHROPIC_BASE_URL = gatewayBase(defaultGateway);
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL = haiku;
  env.ANTHROPIC_SMALL_FAST_MODEL = haiku;
  env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'claude-sonnet-4.6';
  env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'claude-opus-4.6';
  await replaceSettings(path, original, JSON.stringify(settings, null, 2) + '\n');
}

async function finishCodex(token) {
  const path = await existingSettings('.codex', 'config.toml');
  if (!path) return;
  const original = await readFile(path, 'utf8');
  // This is the provider block emitted by the pinned Go release.
  const envKey = 'env_key = "APIHUB_API_KEY"';
  const provider = [
    '[model_providers.apihub]',
    'name = "APIHUB"',
    `base_url = "${defaultGateway}"`,
    envKey,
    '',
  ].join('\n');
  const updated = original.replace(provider, () =>
    provider.replace(envKey, () => `experimental_bearer_token = ${JSON.stringify(token)}`));
  if (updated === original) {
    throw new Error('Настройщик не подтвердил подключение Codex к APIHub.');
  }
  // The Go installer can select a model that only supports Chat Completions.
  const firstTable = updated.search(/^[ \t]*\[/m);
  const root = updated.slice(0, firstTable);
  const selection = 'model = "gpt-6.1-sol"';
  const modelLine = /^[ \t]*model[ \t]*=[^\r\n]*/m;
  const configured = modelLine.test(root) ? root.replace(modelLine, selection) : selection + '\n' + root;
  await replaceSettings(path, original, configured + updated.slice(firstTable), 'Codex');
}

async function openCodeAdapter() {
  if (!await existingSettings('.config', 'opencode', 'opencode.json')) return;
  const version = spawnSync('opencode', ['--version'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5000,
  }).stdout?.trim();
  // OpenCode 1.0 expects the v2 streaming protocol supplied by SDK version 1.
  if (!/^1\.0\.\d+$/.test(version ?? '')) return;
  const sdk = '@ai-sdk/openai-compatible';
  const sdkVersion = '1.0.63';
  const prefix = join(homedir(), '.config', 'opencode', 'apihub-sdk-' + sdkVersion);
  const entry = join(prefix, 'node_modules', sdk, 'dist', 'index.mjs');
  try {
    await access(entry);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const npm = process.env.npm_execpath;
    if (!npm) throw new Error('Запустите установщик через npx, чтобы настроить OpenCode.');
    const result = spawnSync(process.execPath, [
      npm, 'install', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund',
      '--registry=https://registry.npmjs.org/', `${sdk}@${sdkVersion}`,
    ], { stdio: ['ignore', 'inherit', 'inherit'] });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error('Не удалось установить адаптер для OpenCode 1.0.');
    await access(entry);
  }
  return pathToFileURL(entry).href;
}

async function finishOpenCode(token, adapter) {
  const path = await existingSettings('.config', 'opencode', 'opencode.json');
  if (!path) return;
  const original = await readFile(path, 'utf8');
  const settings = JSON.parse(original);
  const provider = settings.provider?.apihub;
  const model = 'gemini-3.1-flash-lite';
  if (provider?.options?.apiKey !== token || provider.options.baseURL !== defaultGateway || !provider.models?.[model]) {
    throw new Error('Настройщик не подтвердил подключение OpenCode к APIHub.');
  }
  settings.model = `apihub/${model}`;
  if (adapter) provider.npm = adapter;
  await replaceSettings(path, original, JSON.stringify(settings, null, 2) + '\n', 'OpenCode');
}

async function install() {
  const platform = process.platform === 'win32' ? 'windows' : process.platform;
  const arch = process.arch === 'x64' ? 'amd64' : process.arch;
  const digest = checksums[`${process.platform}-${process.arch}`];
  if (!digest) throw new Error('Для этой системы нет готового установщика.');

  const token = await askForToken();
  const adapter = await openCodeAdapter();
  const name = `apihub-setup-${platform}-${arch}${platform === 'windows' ? '.exe' : ''}`;
  const response = await fetch(`${release}/${name}`, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Не удалось скачать установщик (HTTP ${response.status}).`);
  const binary = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(binary).digest('hex') !== digest) {
    throw new Error('Контрольная сумма установщика не совпала.');
  }

  const dir = await mkdtemp(join(tmpdir(), 'apihub-install-'));
  const executable = join(dir, name);
  try {
    await writeFile(executable, binary, { flag: 'wx', mode: 0o700 });
    const result = spawnSync(executable, [], {
      env: { ...process.env, APIHUB_TOKEN: token },
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error('Не удалось завершить настройку агентов.');
    await finishClaudeCode(token);
    await finishCodex(token);
    await finishOpenCode(token, adapter);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

try {
  const args = process.argv.slice(2);
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log('Запустите без аргументов, чтобы подключить найденные агенты к APIHub.');
  } else if (args.length === 0) {
    await install();
  } else {
    throw new Error('Установщик запускается без аргументов.');
  }
} catch (error) {
  console.error(`APIHub: ${error.message}`);
  process.exitCode = 1;
}
