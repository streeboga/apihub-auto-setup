import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

export const model = 'apihub-auto';
export const defaultGateway = 'https://g.gnzs.pro/g/v1';
export const strategies = ['optimal', 'cheaper', 'faster', 'reliable'];
const strategyHeader = 'X-APIHub-Strategy';

export function gatewayBase(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Expected a gateway URL.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('The gateway URL must be provided without credentials, query or fragment.');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('The gateway URL must use HTTPS or loopback HTTP.');
  }
  return url.origin + url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '');
}

async function readSettings(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function asObject(value, name) {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new Error(`${name} must be a JSON object.`);
  }
  return value;
}

async function settingsPath() {
  const path = resolve(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json');
  try {
    return await realpath(path);
  } catch (error) {
    if (error.code === 'ENOENT') return path;
    throw error;
  }
}

async function replaceSettings(path, original, content) {
  const staged = join(dirname(path), `.apihub-settings-${randomUUID()}`);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await writeFile(staged, content, { flag: 'wx', mode: 0o600 });
    if (await readSettings(path) !== original) {
      throw new Error('Claude Code settings changed during setup. Retry the command.');
    }
    await rename(staged, path);
  } finally {
    await rm(staged, { force: true });
  }
}

export function requireToken() {
  const token = process.env.APIHUB_TOKEN?.trim();
  if (!token || /[\r\n]/.test(token)) {
    throw new Error('Set APIHUB_TOKEN to your APIHub key.');
  }
  return token;
}

export async function applyClaudeCode(strategy, base, token) {
  if (!strategies.includes(strategy)) {
    throw new Error(`Choose a strategy from ${strategies.join(', ')}.`);
  }
  const path = await settingsPath();
  const original = await readSettings(path);
  let settings;
  try {
    settings = original === undefined ? {} : JSON.parse(original);
  } catch {
    throw new Error('Claude Code settings contain invalid JSON.');
  }
  asObject(settings, 'Claude Code settings');
  const env = settings.env === undefined ? {} : asObject(settings.env, 'settings.env');
  const existing = env.ANTHROPIC_CUSTOM_HEADERS ?? '';
  if (typeof existing !== 'string') {
    throw new Error('ANTHROPIC_CUSTOM_HEADERS must be a string.');
  }
  const headerName = (line) => line.split(':', 1)[0].trim().toLowerCase();
  const lines = existing.split(/\r?\n/).filter((line) => line.trim());
  const credentialHeaders = ['authorization', 'x-api-key', 'proxy-authorization', 'cookie'];
  if (env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || settings.apiKeyHelper ||
      lines.some((line) => credentialHeaders.includes(headerName(line)))) {
    throw new Error('Claude Code has a conflicting API credential or credential helper.');
  }
  const headers = lines.filter((line) => headerName(line) !== strategyHeader.toLowerCase());
  headers.push(`${strategyHeader}: ${strategy}`);

  settings.model = model;
  settings.env = {
    ...env,
    ANTHROPIC_BASE_URL: base,
    ANTHROPIC_AUTH_TOKEN: token,
    ANTHROPIC_CUSTOM_MODEL_OPTION: model,
    ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: 'APIHub Auto',
    ANTHROPIC_CUSTOM_HEADERS: headers.join('\n'),
  };
  const updated = JSON.stringify(settings, null, 2) + '\n';
  if (updated === original) return { path, changed: false };

  if (original !== undefined) {
    const timestamp = new Date().toISOString().replaceAll(':', '-');
    const backup = `${path}.bak.${timestamp}-${randomUUID()}`;
    await writeFile(backup, original, { flag: 'wx', mode: 0o600 });
  }
  await replaceSettings(path, original, updated);
  return { path, changed: true };
}

async function restoreClaudeCode() {
  const path = await settingsPath();
  const dir = dirname(path);
  const prefix = basename(path) + '.bak.';
  const backup = (await readdir(dir)).filter((name) => name.startsWith(prefix)).sort().pop();
  if (!backup) throw new Error('No Claude Code settings backup found.');
  await replaceSettings(path, await readSettings(path), await readFile(join(dir, backup), 'utf8'));
  console.log(`Restored Claude Code settings in ${path}.`);
}

export async function run(args) {
  const { values } = parseArgs({
    args,
    options: {
      apply: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      restore: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      strategy: { type: 'string' },
      agent: { type: 'string' },
      gateway: { type: 'string', default: defaultGateway },
    },
  });
  if (values.help || !args.length) {
    console.log('node setup.mjs (--dry-run | --apply | --restore) [--strategy optimal|cheaper|faster|reliable | --agent "REQUEST"]');
    return;
  }
  if ([values.apply, values['dry-run'], values.restore].filter(Boolean).length !== 1) {
    throw new Error('Select exactly one of --dry-run, --apply and --restore.');
  }
  if (values.restore) {
    if (values.agent !== undefined) throw new Error('--restore cannot be combined with --agent.');
    return restoreClaudeCode();
  }
  const base = gatewayBase(values.gateway);
  let strategy = values.strategy ?? 'optimal';
  if (values.agent !== undefined) {
    if (values.strategy !== undefined || !values.agent.trim() || values.agent.length > 2000) {
      throw new Error('Pass a nonempty --agent request up to 2000 characters without --strategy.');
    }
    const token = requireToken();
    let chooseStrategy;
    try {
      ({ chooseStrategy } = await import('./agent.mjs'));
    } catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
      throw new Error('Install Pi with npm ci --ignore-scripts before using --agent.');
    }
    strategy = await chooseStrategy(values.agent, base, token);
  }
  if (!strategies.includes(strategy)) {
    throw new Error(`Choose a strategy from ${strategies.join(', ')}.`);
  }
  if (values['dry-run']) {
    console.log(`Claude Code → ${base}/v1/messages · model ${model} · strategy ${strategy}`);
    return;
  }
  const result = await applyClaudeCode(strategy, base, requireToken());
  console.log(`Claude Code uses ${model} (${strategy}) via ${base}.`);
  console.log(`Settings ${result.changed ? 'updated' : 'already current'} in ${result.path}.`);
}
