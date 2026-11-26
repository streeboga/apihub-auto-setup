import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { link, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import spawn from 'cross-spawn';
import { applyClaudeCode, defaultGateway, gatewayBase, model as autoModel, prepareClaudeCodeSettings, replaceSettings, strategies } from './setup.mjs';
import { modelsForHarness, normalizeModels } from './models.mjs';

import { desktopGateway, desktopModel, desktopProfile, findDesktopApp, openDesktop, prepareDesktopRestore, reopenDesktop } from './desktop-launch.mjs';

export { desktopGateway, desktopModel };
export { autoModel };

const autoProvider = autoModel;
const autoContextWindow = 65_536;
const auto = { id: autoModel, name: 'APIHub Auto', context: autoContextWindow };

export const harnesses = [
  { value: 'opencode', label: 'OpenCode', command: 'opencode', endpoint: '/chat/completions', strategy: true,
    install: 'Установка · https://opencode.ai/docs/' },
  { value: 'deepseek-harness', label: 'DeepSeek Harness', command: 'dsh', endpoint: '/chat/completions', strategy: true,
    install: 'Установка · npm install -g @deepseek-ai/dsh' },
  { value: 'kimi-code', label: 'Kimi Code', command: 'kimi', endpoint: '/chat/completions',
    install: 'Установка · https://www.kimi.com/code/docs/en/kimi-code-cli/' },
  { value: 'pi', label: 'Pi', command: 'pi', endpoint: '/chat/completions', strategy: true,
    install: 'Установка · npm install -g --ignore-scripts @earendil-works/pi-coding-agent' },
  { value: 'claude-code', label: 'Claude Code', command: 'claude', endpoint: '/messages', strategy: true,
    install: 'Установка · https://code.claude.com/docs/en/setup' },
  { value: 'claude-desktop', label: 'Claude Desktop', endpoint: '/messages', strategy: true },
  { value: 'antigravity', label: 'Antigravity', unavailable: 'Google документирует Gemini API и собственную авторизацию' },
  { value: 'codex', label: 'Codex CLI', command: 'codex', endpoint: '/responses', strategy: true,
    install: 'Установка · npm install -g @openai/codex' },
  { value: 'chatgpt-desktop', label: 'ChatGPT Desktop', unavailable: 'использует штатный список моделей' },
  { value: 'continue', label: 'Continue CLI', command: 'cn', endpoint: '/chat/completions', strategy: true,
    install: 'Установка CLI · npm install -g @continuedev/cli\nНастройка расширения · https://docs.continue.dev/customize/deep-dives/configuration' },
  { value: 'aider', label: 'Aider', command: 'aider', endpoint: '/chat/completions', strategy: true,
    install: 'Установка · https://aider.chat/docs/install.html' },
  { value: 'cline', label: 'Cline', endpoint: '/chat/completions',
    guide: 'В Cline откройте Settings → API Provider → OpenAI Compatible.\nУкажите Base URL, API Key и Model ID.\nhttps://docs.cline.bot/provider-config/openai-compatible',
    restoreGuide: 'В Cline откройте Settings → API Provider и выберите прежнего провайдера и модель.' },
  { value: 'cursor', label: 'Cursor', endpoint: '/chat/completions',
    guide: 'Откройте Cursor Settings → Models. Включите OpenAI API Key и Override OpenAI Base URL.\nДобавьте модель apihub-auto и выберите её в чате. На командном тарифе может потребоваться разрешение администратора.\nhttps://cursor.com/help/models-and-usage/api-keys',
    restoreGuide: 'В Cursor Settings → Models верните прежний OpenAI Base URL или отключите Override OpenAI Base URL. Выберите прежнюю модель в чате.' },
];

const agentValues = ['claude-code', 'claude-desktop', 'opencode'];
const exec = promisify(execFile);

export async function detectHarnesses() {
  return Promise.all(harnesses.map(async (harness) => {
    const available = !harness.unavailable && !harness.guide && (!harness.command ||
      await exec(process.platform === 'win32' ? 'where.exe' : 'which', [harness.command]).then(() => true, () => false));
    const desktop = harness.value === 'claude-desktop' && !process.env.APIHUB_DESKTOP_PROFILE && await findDesktopApp();
    return {
      ...harness,
      available,
      note: harness.unavailable || (harness.guide ? 'настройка в приложении' : !available ? `команда ${harness.command} не найдена`
        : harness.value === 'claude-desktop' ? (desktop ? 'настроить и открыть' : 'создать профиль для импорта') : undefined),
    };
  }));
}

function configuredGateway() {
  return process.env.APIHUB_GATEWAY?.trim() || defaultGateway;
}

async function profilePath() {
  const configured = process.env.APIHUB_DESKTOP_PROFILE;
  if (configured) return resolve(configured);
  return join(homedir(), '.config', 'apihub-auto', 'claude-desktop.json');
}

function keyPath() {
  return resolve(process.env.APIHUB_KEY_FILE || join(homedir(), '.config', 'apihub-auto', 'credentials.json'));
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

async function savedTokenFromProfiles() {
  const stored = await readJson(keyPath());
  if (typeof stored?.apiKey === 'string' && /^[!-~]+$/.test(stored.apiKey)) return stored.apiKey;

  const claudePath = resolve(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json');
  const claude = await readJson(claudePath);
  const claudeToken = claude?.env?.ANTHROPIC_AUTH_TOKEN;
  if (claude?.env?.ANTHROPIC_BASE_URL === gatewayBase(defaultGateway) &&
      typeof claudeToken === 'string' && /^[!-~]+$/.test(claudeToken)) return claudeToken;

  const desktop = await readJson(await profilePath());
  const desktopToken = desktop?.inferenceGatewayApiKey;
  if (desktop?.inferenceGatewayBaseUrl === desktopGateway &&
      typeof desktopToken === 'string' && /^[!-~]+$/.test(desktopToken)) return desktopToken;

  const openCode = await readJson(join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode', 'opencode.json'));
  const openCodeToken = openCode?.provider?.apihub?.options?.apiKey;
  if (openCode?.provider?.apihub?.options?.baseURL === defaultGateway &&
      typeof openCodeToken === 'string' && /^[!-~]+$/.test(openCodeToken)) return openCodeToken;
  return undefined;
}

export async function getSavedToken() {
  return savedTokenFromProfiles();
}

function additionalModelsPath() {
  return join(dirname(keyPath()), 'additional-models.json');
}

export async function getAdditionalModels() {
  const settings = await readJson(additionalModelsPath());
  return Array.isArray(settings?.models) ? normalizeModels(settings.models) : undefined;
}

export async function saveAdditionalModels(models) {
  const path = additionalModelsPath();
  const next = JSON.stringify({ models: normalizeModels(models) }, null, 2) + '\n';
  const original = await readFile(path, 'utf8').catch((error) => error.code === 'ENOENT' ? undefined : Promise.reject(error));
  if (original !== next) await replaceSettings(path, original, next, 'Дополнительные модели APIHub');
}

function harnessSettingsPath(harness) {
  return join(dirname(keyPath()), 'harnesses', `${harness.value}.json`);
}

export async function getHarnessStrategy(harness) {
  if (!harness.strategy) return 'optimal';
  const stored = await readJson(harnessSettingsPath(harness));
  return strategies.includes(stored?.strategy) ? stored.strategy : 'optimal';
}

export async function saveHarnessStrategy(harness, strategy) {
  if (!harness.strategy || !strategies.includes(strategy)) throw new Error('Недоступная стратегия.');
  const path = harnessSettingsPath(harness);
  const content = JSON.stringify({ strategy }) + '\n';
  const previous = await readFile(path, 'utf8').catch((error) => error.code === 'ENOENT' ? undefined : Promise.reject(error));
  if (previous !== content) await replaceSettings(path, previous, content, harness.label);
}

export async function saveToken(token) {
  const path = keyPath();
  const content = JSON.stringify({ apiKey: token }) + '\n';
  const current = await readFile(path, 'utf8').catch((error) => error.code === 'ENOENT' ? undefined : Promise.reject(error));
  if (current === content) return { path, changed: false };
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const staged = join(dirname(path), `.apihub-key-${randomUUID()}`);
  try {
    await writeFile(staged, content, { flag: 'wx', mode: 0o600 });
    await rename(staged, path);
  } finally {
    await rm(staged, { force: true });
  }
  return { path, changed: true };
}

async function writeDesktopProfile(token, strategy = 'optimal', models = []) {
  const path = await profilePath();
  const content = JSON.stringify(desktopProfile(token, strategy, models), null, 2) + '\n';
  let existing;
  try {
    existing = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (existing !== undefined) {
    if (existing === content) return { path, changed: false };
    let previous;
    try { previous = JSON.parse(existing); } catch { /* Other profiles are left alone. */ }
    const previousModels = Array.isArray(previous?.inferenceModels)
      ? previous.inferenceModels.slice(1).filter((entry) => entry && typeof entry.name === 'string' && typeof entry.labelOverride === 'string')
        .map(({ name, labelOverride }) => ({ id: name, name: labelOverride }))
      : [];
    if (strategies.some((mode) => [false, true].some((legacy) =>
      existing === JSON.stringify(desktopProfile(token, mode, previousModels, { legacy }), null, 2) + '\n'))) {
      await replaceSettings(path, existing, content, 'Claude Desktop');
      return { path, changed: true };
    }
    throw new Error(`Claude Desktop profile already exists at ${path}; it was left unchanged. Move it or set APIHUB_DESKTOP_PROFILE to a new path.`);
  }

  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const staged = join(dirname(path), `.apihub-desktop-${randomUUID()}`);
  try {
    await writeFile(staged, content, { flag: 'wx', mode: 0o600 });
    await link(staged, path);
  } finally {
    await rm(staged, { force: true });
  }
  return { path, changed: true };
}

async function preflightDesktopProfile(token) {
  const path = await profilePath();
  let existing;
  try {
    existing = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const content = JSON.stringify(desktopProfile(token), null, 2) + '\n';
  if (existing !== undefined && existing !== content) {
    throw new Error(`Claude Desktop profile already exists at ${path}; it was left unchanged. Move it or set APIHUB_DESKTOP_PROFILE to a new path.`);
  }
  return path;
}

export async function verifyGateway(token) {
  if (process.env.APIHUB_SKIP_GATEWAY_CHECK === '1') return;
  const gateway = configuredGateway().replace(/\/+$/, '');
  let response;
  try {
    response = await fetch(`${gateway}/models`, {
      headers: { authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error('APIHub gateway is unavailable. Check the network or try again later; no settings were changed.');
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error('APIHub rejected this key (HTTP 401/403). Check the key and try again; no settings were changed.');
  }
  if (response.status === 404 || response.status >= 500) {
    throw new Error(`APIHub route/provider is unavailable (HTTP ${response.status}); no settings were changed.`);
  }
  if (!response.ok) {
    throw new Error(`APIHub gateway preflight failed (HTTP ${response.status}); no settings were changed.`);
  }
}

async function applyOpenCode(token) {
  const path = join(homedir(), '.config', 'opencode', 'opencode.json');
  const original = await readFile(path, 'utf8').catch((error) => error.code === 'ENOENT' ? undefined : Promise.reject(error));
  if (original === undefined) return { status: 'skipped', message: 'OpenCode не найден; пропущен.' };
  let settings;
  try { settings = JSON.parse(original); } catch { throw new Error('OpenCode config contains invalid JSON.'); }
  if (!settings.provider || typeof settings.provider !== 'object') settings.provider = {};
  const provider = settings.provider.apihub && typeof settings.provider.apihub === 'object' ? settings.provider.apihub : {
    name: 'APIHUB', options: { baseURL: defaultGateway }, models: {},
  };
  provider.options = { ...(provider.options || {}), apiKey: token, baseURL: provider.options?.baseURL || defaultGateway };
  settings.provider.apihub = provider;
  const updated = JSON.stringify(settings, null, 2) + '\n';
  if (updated === original) return { status: 'current', message: 'OpenCode уже настроен; список моделей и выбранная модель сохранены.' };
  await replaceSettings(path, original, updated, 'OpenCode');
  return { status: 'changed', message: 'OpenCode подключён; список моделей и выбранная модель сохранены.' };
}

export async function runInstaller(token, { agents = agentValues, strategy = 'optimal', verify = true } = {}) {
  if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)) {
    throw new Error('An APIHub key is required.');
  }
  if (!strategies.includes(strategy)) {
    throw new Error(`Choose an APIHub strategy from ${strategies.join(', ')}.`);
  }

  const selected = new Set(agents);
  if (verify) await verifyGateway(token.trim());
  if (selected.has('claude-desktop')) await preflightDesktopProfile(token.trim());
  const gateway = gatewayBase(configuredGateway());
  const results = [];
  if (selected.has('claude-code')) {
    const claude = await applyClaudeCode(strategy, gateway, token.trim());
    results.push(`Claude Code: ${claude.changed ? 'настроен' : 'уже настроен'} на APIHub Auto (${strategy}).`);
  }
  if (selected.has('claude-desktop')) {
    const desktop = await writeDesktopProfile(token.trim());
    results.push(`Claude Desktop: ${desktop.changed ? 'профиль создан' : 'профиль уже актуален'}: ${desktop.path}. Импортируйте его в Desktop.`);
    results.push('Claude Desktop подключается напрямую по HTTPS; локальный сервис не нужен.');
  }
  if (selected.has('opencode')) results.push((await applyOpenCode(token.trim())).message);
  if (selected.has('codex')) results.push('Codex не изменяется по дизайну установщика.');
  for (const result of results) console.log(result);
}

async function spawnAndWait(command, args, env, { beforeOutput, writeOutput, timeoutMs } = {}) {
  if (!writeOutput) beforeOutput?.();
  const detached = Boolean(timeoutMs) && process.platform !== 'win32';
  const child = spawn(command, args, { stdio: writeOutput ? ['ignore', 'pipe', 'pipe'] : 'inherit', env, detached });
  if (writeOutput) {
    child.stdout.on('data', (chunk) => writeOutput(process.stdout, chunk));
    child.stderr.on('data', (chunk) => writeOutput(process.stderr, chunk));
  }
  let timer;
  let killTimer;
  let stopReason;
  const signalChild = (signal) => {
    try {
      if (detached && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  };
  const stop = (reason) => {
    if (stopReason) return;
    stopReason = reason;
    signalChild('SIGTERM');
    killTimer = setTimeout(() => signalChild('SIGKILL'), 1000);
  };
  const interrupt = () => stop('SIGINT');
  const terminate = () => stop('SIGTERM');
  if (timeoutMs) {
    timer = setTimeout(() => stop('timeout'), timeoutMs);
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
  }
  try {
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    if (stopReason === 'timeout') return { ...result, timedOut: true };
    return stopReason ? { ...result, signal: stopReason } : result;
  } finally {
    clearTimeout(timer);
    clearTimeout(killTimer);
    if (timeoutMs) {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', terminate);
    }
    if (detached && stopReason) signalChild('SIGKILL');
  }
}

async function claudeSessionSettings(token, strategy, models) {
  const originalPath = resolve(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json');
  const original = await readFile(originalPath, 'utf8').catch((error) => error.code === 'ENOENT' ? undefined : Promise.reject(error));
  const settings = JSON.parse(prepareClaudeCodeSettings(strategy, gatewayBase(configuredGateway()), token, original));
  settings.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(autoContextWindow);
  if (models.length) {
    settings.modelPicker = {
      replaceBuiltInOptions: true,
      options: [auto, ...models].map(({ id, name }) => ({ model: id, label: name })),
    };
  }
  if (Array.isArray(settings.permissions?.allow)) {
    // Leave malformed grants out of the session instead of converting them into broader permissions.
    settings.permissions.allow = settings.permissions.allow.filter((rule) =>
      typeof rule !== 'string' || !/^Bash\(.*\*.*:\*\)$|^Write\((?!\*\)$).+\)$/.test(rule));
  }
  return JSON.stringify(settings, null, 2) + '\n';
}

async function withSessionFiles(run) {
  const dir = await mkdtemp(join(tmpdir(), 'apihub-harness-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function openCodeLaunch(baseURL, headers, args, models) {
  const settings = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}');
  const result = spawn.sync('opencode', ['--version'], { encoding: 'utf8', timeout: 5_000 });
  const version = result.stdout?.match(/(\d+)\.(\d+)\.(\d+)\b/);
  if (!version || result.status !== 0) throw new Error('Не удалось определить версию OpenCode.');
  const [, major, minor, patch] = version.map(Number);
  const model = `${autoProvider}/${autoModel}`;
  const provider = {
    name: 'APIHub Auto',
    env: ['APIHUB_TOKEN'],
    models: Object.fromEntries(models.map(({ id, name }) => [id, { name, tool_call: true }])),
  };
  if (major >= 2) {
    return {
      args: [...args, '--standalone'],
      config: {
        ...settings,
        model,
        providers: {
          ...settings.providers,
          [autoProvider]: {
            name: provider.name,
            env: provider.env,
            models: Object.fromEntries(models.map(({ id, name }) => [id, { name }])),
            package: '@opencode/ai/providers/openai-compatible',
            settings: { baseURL }, headers,
          },
        },
      },
    };
  }
  // OpenCode 1.3.4 moved from AI SDK provider protocol v2 to v3.
  const sdk = minor < 3 || (minor === 3 && patch < 4) ? '@ai-sdk/openai-compatible' : 'opencode-chat-sdk-v3';
  return {
    args: [...args, '--model', model],
    config: {
      ...settings,
      provider: {
        ...settings.provider,
        [autoProvider]: {
          ...provider,
          npm: import.meta.resolve(sdk),
          options: { baseURL, headers, includeUsage: true },
        },
      },
    },
  };
}

function codexModelCatalog(models) {
  return { models: models.map(({ id, name, context }, priority) => ({
    slug: id, display_name: name, priority, visibility: 'list', supported_in_api: true,
    shell_type: 'unified_exec', supported_reasoning_levels: [], support_verbosity: false,
    supports_reasoning_summary_parameter: false, experimental_supported_tools: [],
    model_messages: { instructions_template: 'You are a coding assistant. Follow the user’s instructions and verify your work.' },
    input_modalities: id === autoModel ? ['text', 'image'] : ['text'],
    context_window: context || autoContextWindow,
    truncation_policy: { mode: 'tokens', limit: 10000 },
  })) };
}

async function kimiProfile(baseURL, models) {
  const dir = join(dirname(keyPath()), 'kimi-code');
  const path = join(dir, 'config.toml');
  const content = [
    `default_model = ${JSON.stringify(autoModel)}`,
    '[providers.apihub]',
    'type = "openai"',
    'api_key_env = "APIHUB_TOKEN"',
    `base_url = ${JSON.stringify(baseURL)}`,
    ...models.flatMap(({ id, name, context }) => [
      '',
      `[models.${JSON.stringify(id)}]`,
      'provider = "apihub"',
      `model = ${JSON.stringify(id)}`,
      `display_name = ${JSON.stringify(name)}`,
      `max_context_size = ${context || autoContextWindow}`,
    ]),
    '',
  ].join('\n');
  const original = await readFile(path, 'utf8').catch((error) => error.code === 'ENOENT' ? undefined : Promise.reject(error));
  if (original !== content) await replaceSettings(path, original, content, 'Kimi Code');
  return dir;
}

export async function launchAgent(agent, token, { strategy = 'optimal', args = [], beforeOutput, writeOutput, timeoutMs } = {}) {
  const harness = harnesses.find(({ value }) => value === agent);
  if (!harness) throw new Error(`Неизвестный харнес: ${agent}.`);
  if (harness.unavailable) throw new Error(`${harness.label}: ${harness.unavailable}.`);
  if (harness.guide) throw new Error(`Подключите ${harness.label} в его настройках через главное меню установщика.`);
  if (!strategies.includes(strategy)) throw new Error(`Выберите стратегию: ${strategies.join(', ')}.`);
  const saved = await getAdditionalModels() || [];
  const extras = modelsForHarness(saved, harness);
  const models = [auto, ...extras];
  if (agent === 'claude-desktop') {
    const unavailable = saved.filter((entry) => !extras.includes(entry));
    if (unavailable.length) {
      beforeOutput?.();
      console.log('Claude Desktop использует протокол /messages. Для этих моделей маршрут недоступен.');
      console.log(`Пропущены в профиле · ${unavailable.map(({ id }) => id).join(', ')}`);
    }
    const app = !process.env.APIHUB_DESKTOP_PROFILE && await findDesktopApp();
    if (app) {
      await openDesktop(app, token, strategy, extras);
      beforeOutput?.();
      console.log('Claude Desktop открыт с профилем «APIHub Auto». Выберите APIHub Auto в списке моделей.');
      return { code: 0 };
    }
    const profile = await writeDesktopProfile(token, strategy, extras);
    beforeOutput?.();
    console.log(`Профиль Claude Desktop ${profile.changed ? 'создан' : 'уже актуален'}: ${profile.path}`);
    console.log('В Claude Desktop включите Help → Troubleshooting → Enable Developer Mode.');
    console.log('Откройте Developer → Configure Third-Party Inference → Import configuration.');
    console.log('Выберите этот JSON, нажмите Apply и полностью перезапустите Claude. Затем выберите модель «APIHub Auto».');
    return { code: 0, profile: profile.path };
  }
  const baseURL = configuredGateway().replace(/\/+$/, '');
  const headers = { 'X-APIHub-Strategy': strategy };
  const env = { ...process.env, APIHUB_TOKEN: token };
  const output = { beforeOutput, writeOutput, timeoutMs };
  if (agent === 'opencode') {
    const launch = openCodeLaunch(baseURL, headers, args, models);
    return spawnAndWait('opencode', launch.args, {
      ...env,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(launch.config),
    }, output);
  }
  if (agent === 'codex') {
    const codexArgs = [
      '--model', autoModel,
      '-c', 'model_provider="apihub_auto"',
      '-c', 'model_providers.apihub_auto.name="APIHub Auto"',
      '-c', `model_providers.apihub_auto.base_url=${JSON.stringify(baseURL)}`,
      '-c', 'model_providers.apihub_auto.env_key="APIHUB_TOKEN"',
      '-c', 'model_providers.apihub_auto.wire_api="responses"',
      '-c', `model_providers.apihub_auto.http_headers.X-APIHub-Strategy=${JSON.stringify(strategy)}`,
    ];
    if (!extras.length) return spawnAndWait('codex', [...codexArgs, ...args], env, output);
    return withSessionFiles(async (dir) => {
      const catalog = join(dir, 'models.json');
      await writeFile(catalog, JSON.stringify(codexModelCatalog(models)), { mode: 0o600 });
      return spawnAndWait('codex', [...codexArgs, '-c', `model_catalog_json=${JSON.stringify(catalog)}`, ...args], env, output);
    });
  }
  if (agent === 'kimi-code') {
    if (strategy !== 'optimal') throw new Error('Kimi Code использует стандартную стратегию optimal.');
    if (extras.length) {
      const profile = await kimiProfile(baseURL, models);
      const kimiEnv = Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith('KIMI_MODEL_')));
      return spawnAndWait('kimi', args, { ...kimiEnv, KIMI_CODE_HOME: profile }, output);
    }
    return spawnAndWait('kimi', args, {
      ...env,
      KIMI_MODEL_NAME: autoModel,
      KIMI_MODEL_DISPLAY_NAME: 'APIHub Auto',
      KIMI_MODEL_PROVIDER_TYPE: 'openai',
      KIMI_MODEL_API_KEY: token,
      KIMI_MODEL_BASE_URL: baseURL,
      KIMI_MODEL_MAX_CONTEXT_SIZE: String(autoContextWindow),
    }, output);
  }
  return withSessionFiles(async (dir) => {
    if (agent === 'continue') {
      const config = join(dir, 'config.yaml');
      await writeFile(config, JSON.stringify({
        name: 'APIHub Auto',
        version: '1.0.0',
        schema: 'v1',
        models: models.map(({ id, name }) => ({
          name, provider: 'openai', model: id, apiBase: baseURL,
          apiKey: '${{ secrets.APIHUB_TOKEN }}',
          roles: ['chat', 'edit', 'apply'],
          capabilities: ['tool_use', 'image_input'],
          defaultCompletionOptions: { contextLength: autoContextWindow, maxTokens: 8192 },
          requestOptions: { headers },
        })),
      }, null, 2), { mode: 0o600 });
      return spawnAndWait('cn', ['--config', config, ...args], env, output);
    }
    if (agent === 'aider') {
      const settings = join(dir, 'aider.model.settings.yml');
      const model = `openai/${autoModel}`;
      await writeFile(settings, JSON.stringify(models.map(({ id }) => ({
        name: `openai/${id}`, extra_params: { extra_headers: headers },
      }))), { mode: 0o600 });
      return spawnAndWait('aider', ['--model', model, '--model-settings-file', settings, ...args], {
        ...env, OPENAI_API_KEY: token, OPENAI_API_BASE: baseURL,
      }, output);
    }
    if (agent === 'claude-code') {
      const settings = await claudeSessionSettings(token, strategy, extras);
      await writeFile(join(dir, 'settings.json'), settings, { mode: 0o600 });
      return spawnAndWait('claude', ['--model', autoModel, ...args], {
        ...env,
        CLAUDE_CONFIG_DIR: dir,
        CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(autoContextWindow),
      }, output);
    }
    if (agent === 'pi') {
      const extension = join(dir, 'apihub.ts');
      const provider = {
        baseUrl: baseURL, api: 'openai-completions', apiKey: '$APIHUB_TOKEN', headers,
        models: models.map(({ id, name }) => ({
          id, name, reasoning: false, input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: autoContextWindow, maxTokens: 8192,
        })),
      };
      await writeFile(extension, `export default (pi) => pi.registerProvider(${JSON.stringify(autoProvider)}, ${JSON.stringify(provider)});\n`, { mode: 0o600 });
      return spawnAndWait('pi', ['--extension', extension, '--model', `${autoProvider}/${autoModel}`, ...args], env, output);
    }
    const patch = join(dir, 'apihub.patch.json');
    await writeFile(patch, JSON.stringify([
      { id: 'agent-default-model', config: { provider: autoProvider, model: autoModel } },
      { id: 'llm-pi-ai', config: { providers: { [autoProvider]: {
        api: 'openai-completions', apiKeyEnv: 'APIHUB_TOKEN', baseURL, headers,
        models: models.map(({ id, name }) => ({ id, name, contextWindow: autoContextWindow, maxTokens: 8192 })),
      } } } },
    ]), { mode: 0o600 });
    return spawnAndWait('dsh', ['--profile', args.length ? 'headless' : 'web', '--patch', patch, ...args], env, output);
  });
}

function settingsFile(agent, home) {
  switch (agent) {
    case 'claude-code':
      return resolve(process.env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'settings.json');
    case 'codex':
      return resolve(process.env.CODEX_HOME || join(home, '.codex'), 'config.toml');
    case 'opencode':
      return resolve(process.env.OPENCODE_CONFIG ||
        join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'opencode', 'opencode.json'));
  }
}

export async function prepareRestoration(agent, home = homedir()) {
  const manual = harnesses.find(({ value }) => value === agent)?.restoreGuide;
  if (manual) return { message: manual };
  if (agent === 'claude-desktop') {
    const app = !process.env.APIHUB_DESKTOP_PROFILE && await findDesktopApp();
    if (!app) {
      return { message: 'Если профиль APIHub Auto был импортирован, выберите прежний профиль в настройках Claude Desktop и переоткройте приложение.' };
    }
    const { message, apply } = await prepareDesktopRestore();
    if (!apply) return { message };
    return {
      message,
      async apply() {
        await reopenDesktop(app, await apply());
        return 'Прежний профиль Claude Desktop восстановлен.';
      },
    };
  }

  const path = settingsFile(agent, home);
  if (!path) return { message: 'Настройки APIHub применялись к сеансу. Обычные настройки агента будут использованы при следующем запуске вне APIHub.' };
  const prefix = basename(path) + '.bak.';
  const backupDate = /^\d{4}-\d{2}-\d{2}(?:-\d{6}|T[\dT.Z-]+-[a-f0-9-]{36})?$/;
  const files = await readdir(dirname(path), { withFileTypes: true }).catch((error) =>
    error.code === 'ENOENT' ? [] : Promise.reject(error));
  const backups = files.filter((file) => file.isFile() && file.name.startsWith(prefix) &&
    backupDate.test(file.name.slice(prefix.length))).map(({ name }) => name).sort();
  if (!backups.length) {
    return { message: 'Резервных копий нет. Настройки APIHub для новых запусков действуют в пределах сеанса.' };
  }

  const backup = join(dirname(path), backups.at(-1));
  const current = await readFile(path, 'utf8').catch((error) => error.code === 'ENOENT' ? undefined : Promise.reject(error));
  const content = await readFile(backup, 'utf8');
  if (current === content) return { message: 'Настройки уже совпадают с резервной копией.' };
  return {
    message: `Будут восстановлены настройки из ${backup}.`,
    async apply() {
      const saved = `${path}.before-apihub-restore.${randomUUID()}`;
      if (current !== undefined) await writeFile(saved, current, { mode: 0o600, flag: 'wx' });
      await replaceSettings(path, current, content, agent);
      return current === undefined ? 'Настройки восстановлены.' : `Настройки восстановлены. Предыдущая версия сохранена в ${saved}.`;
    },
  };
}

export async function restoreClaudeCode(beforeOutput) {
  const restoration = await prepareRestoration('claude-code');
  if (!restoration.apply) {
    beforeOutput?.();
    console.log(restoration.message);
    return;
  }
  const message = await restoration.apply();
  beforeOutput?.();
  console.log(message);
}
