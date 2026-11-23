#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { defaultGateway, replaceSettings } from './src/setup.mjs';

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

async function saveCodexToken(token) {
  let path;
  try {
    path = await realpath(join(homedir(), '.codex', 'config.toml'));
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }

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
  await replaceSettings(path, original, updated, 'Codex');
}

async function install() {
  const platform = process.platform === 'win32' ? 'windows' : process.platform;
  const arch = process.arch === 'x64' ? 'amd64' : process.arch;
  const digest = checksums[`${process.platform}-${process.arch}`];
  if (!digest) throw new Error('Для этой системы нет готового установщика.');

  const token = await askForToken();
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
    await saveCodexToken(token);
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
