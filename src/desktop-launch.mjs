import { execFile } from 'node:child_process';
import { access, readFile, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { promisify } from 'node:util';
import { autoClaudeClassifier, cheapClaudeModels, replaceSettings, strategyHeader } from './setup.mjs';

const exec = promisify(execFile);
export const desktopGateway = 'https://g.gnzs.pro/g/v1/claude-desktop';
export const desktopModel = 'claude-fable-5';
const desktopModelPrefix = 'claude-apihub-';
const profileId = '980b8947-a3de-4a66-8afc-07d47ebc8012';
const profileName = 'APIHub Auto';
const cheapClassifier = { id: autoClaudeClassifier, name: 'APIHub Auto · проверка действий' };
const supportRoot = () => join(homedir(), 'Library', 'Application Support');
const previousPath = (support) => join(support, 'Claude-3p', 'apihub-auto-previous.json');
const managedModelsPath = (support) => join(support, 'Claude-3p', 'apihub-auto-models.json');
const legacyPath = () => join(homedir(), '.local', 'state', 'apihub-auto', 'desktop-profile.json');
const appSettings = (support) => ['Claude', 'Claude-3p'].map((app) =>
  configFile(join(support, app, 'claude_desktop_config.json')));

function desktopModelName(id) {
  if (id === autoClaudeClassifier) return id;
  if (id !== desktopModel && /^claude-(opus|sonnet|haiku|fable|mythos)-/.test(id)) return id;
  if (/^claude-apihub-(?:[0-9a-f]{2})+$/.test(id)) return id;
  return desktopModelPrefix + Buffer.from(id).toString('hex');
}

function desktopModelEntry({ id, name }) {
  const route = desktopModelName(id);
  return {
    name: route, labelOverride: name,
    ...(route.startsWith(desktopModelPrefix) || route === autoClaudeClassifier
      ? { behavesAs: 'claude-haiku-4-5', maxEffort: 'low' } : {}),
  };
}

function addClassifier(models, strategy) {
  if (strategy !== 'cheaper' || models.some(({ id }) => desktopModelName(id) === cheapClassifier.id)) return models;
  return [...models, cheapClassifier];
}

export function desktopProfile(token, strategy = 'optimal', models = [], { legacy = false, hasClassifier = false } = {}) {
  const cheap = strategy === 'cheaper' && !legacy;
  return {
    inferenceProvider: 'gateway',
    inferenceGatewayBaseUrl: desktopGateway,
    inferenceGatewayAuthScheme: 'bearer',
    inferenceGatewayApiKey: token,
    ...(strategy === 'optimal' ? {} : { inferenceCustomHeaders: { [strategyHeader]: strategy } }),
    inferenceModels: [{
      name: desktopModel,
      labelOverride: profileName,
      anthropicFamilyTier: 'fable',
      isFamilyDefault: true,
    }, ...addClassifier(models, cheap && !hasClassifier ? 'cheaper' : 'optimal').map(desktopModelEntry)],
    modelDiscoveryEnabled: false,
    ...(cheap ? {
      autoModeClassifierModel: autoClaudeClassifier,
      claudeCodeSettings: { env: cheapClaudeModels(desktopModel) },
    } : {}),
  };
}

function applyServiceModels(profile, nextProfile, strategy, previous) {
  const overrides = cheapClaudeModels(desktopModel);
  const settings = { ...profile.claudeCodeSettings };
  const env = { ...settings.env };
  if (strategy === 'cheaper') {
    nextProfile.claudeCodeSettings = { ...settings, env: { ...env, ...overrides } };
    return previous ?? {
      classifier: profile.autoModeClassifierModel ?? null,
      hadSettings: Object.hasOwn(profile, 'claudeCodeSettings'),
      hadEnv: Object.hasOwn(settings, 'env'),
      env: Object.fromEntries(Object.keys(overrides).map((key) => [key, env[key] ?? null])),
    };
  }
  if (!previous) return;
  if (nextProfile.autoModeClassifierModel === autoClaudeClassifier) {
    if (previous.classifier === null) delete nextProfile.autoModeClassifierModel;
    else nextProfile.autoModeClassifierModel = previous.classifier;
  }
  for (const [key, current] of Object.entries(overrides)) {
    if (env[key] !== current) continue;
    if (previous.env[key] === null) delete env[key];
    else env[key] = previous.env[key];
  }
  if (!Object.keys(env).length && !previous.hadEnv) delete settings.env;
  else settings.env = env;
  if (!Object.keys(settings).length && !previous.hadSettings) delete nextProfile.claudeCodeSettings;
  else nextProfile.claudeCodeSettings = settings;
}

export async function findDesktopApp() {
  if (process.platform !== 'darwin') return;
  for (const path of ['/Applications/Claude.app', join(homedir(), 'Applications', 'Claude.app')]) {
    if (await access(path).then(() => true, () => false)) return path;
  }
}

async function configFile(path) {
  try {
    const original = await readFile(path, 'utf8');
    const value = JSON.parse(original);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`Claude Desktop: неверный JSON-объект в ${path}.`);
    }
    return { path, original, value };
  } catch (error) {
    if (error.code === 'ENOENT') return { path, original: undefined, value: {} };
    throw error;
  }
}

async function saveProfileFiles(updates) {
  const changed = updates.filter(([{ value }, next]) => JSON.stringify(value) !== JSON.stringify(next));
  const written = [];
  try {
    for (const [{ path, original }, next] of changed) {
      const content = JSON.stringify(next, null, 2) + '\n';
      await replaceSettings(path, original, content, 'Claude Desktop');
      written.push({ path, original, content });
    }
  } catch (error) {
    const failed = [];
    for (const { path, original, content } of written.reverse()) {
      try {
        if (original !== undefined) {
          await replaceSettings(path, content, original, 'Claude Desktop');
        } else if (await readFile(path, 'utf8') === content) {
          await unlink(path);
        }
      } catch {
        failed.push(path);
      }
    }
    if (failed.length) throw new Error(`${error.message} Не удалось вернуть файлы: ${failed.join(', ')}.`, { cause: error });
    throw error;
  }
  return written.length > 0;
}

export async function activateDesktopProfile(token, support = supportRoot(), strategy = 'optimal', models = []) {
  const library = join(support, 'Claude-3p', 'configLibrary');
  const [meta, profile, managedModels, ...preferences] = await Promise.all([
    configFile(join(library, '_meta.json')),
    configFile(join(library, `${profileId}.json`)),
    configFile(managedModelsPath(support)),
    ...appSettings(support),
  ]);
  if (meta.value.hybridPointer) {
    throw new Error('Claude Desktop использует профиль организации. Выберите личный профиль в настройках приложения.');
  }
  if (profile.original !== undefined &&
      ![desktopGateway, 'http://127.0.0.1:8788'].includes(profile.value.inferenceGatewayBaseUrl)) {
    throw new Error('Профиль APIHub Auto уже используется другим шлюзом. Проверьте профили в Claude Desktop.');
  }

  const previousModels = profile.value.inferenceModels || [];
  const previouslyManaged = new Set(Array.isArray(managedModels.value.ids) ? managedModels.value.ids : []);
  const existingModels = previousModels.filter((entry) => {
    const id = typeof entry === 'string' ? entry : entry.name;
    return id !== desktopModel && !previouslyManaged.has(id);
  });
  const userIds = new Set(existingModels.map((entry) => typeof entry === 'string' ? entry : entry.name));
  const managed = addClassifier(models, userIds.has(cheapClassifier.id) ? 'optimal' : strategy)
    .filter(({ id }) => !userIds.has(desktopModelName(id)));
  const nextProfile = {
    ...profile.value,
    ...desktopProfile(token, strategy, managed, { hasClassifier: userIds.has(cheapClassifier.id) }),
    inferenceCustomHeaders: {
      ...Object.fromEntries(Object.entries(profile.value.inferenceCustomHeaders || {})
        .filter(([name]) => name.toLowerCase() !== strategyHeader.toLowerCase())),
      [strategyHeader]: strategy,
    },
    inferenceCredentialKind: 'static',
    deploymentDisplayName: profileName,
    isClaudeCodeForDesktopEnabled: true,
    alwaysStartWithDefaultModel: true,
    modelCatalogEnabled: false,
  };
  const serviceModels = applyServiceModels(profile.value, nextProfile, strategy, managedModels.value.serviceModels);
  nextProfile.inferenceModels.push(...existingModels);
  const entries = [...(meta.value.entries || [])];
  const index = entries.findIndex((entry) => entry.id === profileId);
  if (index === -1) entries.push({ id: profileId, name: profileName });
  else entries[index] = { ...entries[index], name: profileName };
  const nextMeta = { ...meta.value, entries, appliedId: profileId };

  const previous = meta.value.appliedId === profileId ? [] : [[await configFile(previousPath(support)), {
    appliedId: meta.value.appliedId ?? null,
    deploymentModes: preferences.map(({ value }) => value.deploymentMode ?? null),
  }]];
  return saveProfileFiles([
    ...previous,
    [profile, nextProfile],
    ...(managed.length || managedModels.original !== undefined ? [[managedModels, {
      ids: managed.map(({ id }) => desktopModelName(id)),
      ...(serviceModels ? { serviceModels } : {}),
    }]] : []),
    ...preferences.map((file) => [file, { ...file.value, deploymentMode: '3p' }]),
    [meta, nextMeta],
  ]);
}

export async function prepareDesktopRestore(support = supportRoot(), legacy = legacyPath()) {
  const [meta, ...preferences] = await Promise.all([
    configFile(join(support, 'Claude-3p', 'configLibrary', '_meta.json')),
    ...appSettings(support),
  ]);
  if (meta.value.hybridPointer) {
    return { message: 'Claude Desktop использует профиль организации. Управление профилем доступно в настройках приложения.' };
  }
  if (meta.value.appliedId !== profileId) {
    return { message: 'Профиль APIHub Auto сейчас не активен в Claude Desktop.' };
  }

  const saved = await configFile(previousPath(support));
  const { appliedId, deploymentModes } = saved.original === undefined ? (await configFile(legacy)).value : saved.value;
  if ((appliedId !== null && (typeof appliedId !== 'string' || appliedId === profileId)) ||
      !Array.isArray(deploymentModes) || deploymentModes.length !== preferences.length ||
      !deploymentModes.every((mode) => mode === null || typeof mode === 'string')) {
    return { message: 'Копия прежнего профиля отсутствует. Выберите нужный профиль в настройках Claude Desktop.' };
  }
  if (appliedId && !meta.value.entries?.some(({ id }) => id === appliedId)) {
    return { message: 'Прежний профиль удалён из Claude Desktop. Выберите другой профиль в настройках приложения.' };
  }
  const nextMeta = { ...meta.value };
  if (appliedId === null) delete nextMeta.appliedId;
  else nextMeta.appliedId = appliedId;
  const updates = preferences.map((file, index) => {
    const next = { ...file.value };
    if (next.deploymentMode === '3p') {
      const previous = deploymentModes[index];
      if (previous === null) delete next.deploymentMode;
      else next.deploymentMode = previous;
    }
    return [file, next];
  });
  return {
    message: 'Будет выбран профиль, который был активен до APIHub Auto. Claude Desktop переоткроется.',
    apply: () => saveProfileFiles([...updates, [meta, nextMeta]]),
  };
}

async function desktopRunning(app) {
  const escaped = app.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return exec('/usr/bin/pgrep', ['-f', `^${escaped}/Contents/MacOS/Claude($| )`], { timeout: 3000 })
    .then(() => true, (error) => {
      if (error.code === 1) return false;
      throw error;
    });
}

export async function openDesktop(app, token, strategy, models = []) {
  let response;
  try {
    response = await fetch(`${desktopGateway}/v1/models`, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new Error('Шлюз Claude Desktop недоступен. Проверьте подключение к APIHub.');
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error('APIHub отклонил ключ. Выберите «Сменить ключ APIHub» в меню.');
  }
  if (!response.ok) throw new Error(`Шлюз Claude Desktop вернул HTTP ${response.status}.`);
  const { data } = await response.json();
  if (!Array.isArray(data) || !data.some((model) => model?.id === desktopModel)) {
    throw new Error('Шлюз Claude Desktop не вернул модель APIHub Auto.');
  }
  if (strategy === 'cheaper' && !data.some((model) => model?.id === autoClaudeClassifier)) {
    throw new Error('Шлюз ещё не поддерживает дешёвый маршрут Auto для проверки действий Claude Desktop.');
  }

  const changed = await activateDesktopProfile(token, undefined, strategy, models);
  await reopenDesktop(app, changed);
}

export async function reopenDesktop(app, changed) {
  if (changed && await desktopRunning(app)) {
    try {
      await exec('/usr/bin/osascript', ['-e', 'tell application id "com.anthropic.claudefordesktop" to quit'], { timeout: 8000 });
      const deadline = Date.now() + 8000;
      while (await desktopRunning(app)) {
        if (Date.now() >= deadline) throw new Error('Claude is still running');
        await wait(250);
      }
    } catch {
      throw new Error('Профиль выбран. Закройте Claude Desktop через ⌘Q и откройте его снова.');
    }
  }
  await exec('/usr/bin/open', ['-a', app], { timeout: 8000 });
}
