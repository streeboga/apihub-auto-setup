#!/usr/bin/env node
import { askMarketplaceQuestion, askSecret, back, chooseAdditionalModels, chooseAgent, chooseAgentAction, chooseAgentSettings, chooseMode, color, confirmRestore, exit, offerAdditionalModels, returnToMenu, terminalLink, withProgress } from './src/tui.mjs';
import { marketplaceLinks } from './src/marketplace.mjs';
import { fetchModelCatalog, modelsForHarness } from './src/models.mjs';
import { defaultGateway, model } from './src/setup.mjs';
import {
  detectHarnesses, getAdditionalModels, getHarnessStrategy, getSavedToken, harnesses, launchAgent,
  prepareRestoration, restoreClaudeCode, saveAdditionalModels, saveHarnessStrategy, saveToken,
} from './src/installer.mjs';

const tokenHelpUrl = 'https://hub.gnzs.pro/app/keys?utm_source=cli&utm_medium=npx&utm_campaign=apihub-auto-setup';
const supported = harnesses.filter(({ unavailable, guide }) => !unavailable && !guide).map(({ value }) => value);

async function resolveToken({ replace = false } = {}) {
  const fromEnv = process.env.APIHUB_TOKEN?.trim();
  if (fromEnv && !replace) return fromEnv;
  const saved = !replace && await withProgress('Ищем сохранённый ключ APIHub', getSavedToken);
  if (saved) {
    console.log(color('success', 'Используем сохранённый ключ APIHub.'));
    return saved;
  }
  return askSecret(`Откройте страницу «Ключи APIHub»\n${terminalLink(tokenHelpUrl)}\n\nВставьте ключ и нажмите Enter.\n`);
}

function persistToken(token) {
  return withProgress('Сохраняем ключ APIHub', () => saveToken(token));
}

function restore() {
  return withProgress('Восстанавливаем настройки Claude Code', ({ stop }) => restoreClaudeCode(stop));
}

async function runHarness(harness, token, strategy) {
  const result = await withProgress(`Подключаем ${harness.label}`, ({ stop }) =>
    launchAgent(harness.value, token, { strategy, beforeOutput: stop }));
  if (result.signal) throw new Error(`${harness.label}: процесс завершился по сигналу ${result.signal}.`);
  if (result.code !== 0) throw new Error(`${harness.label}: код завершения ${result.code}.`);
}

async function configureLaunch(harness) {
  const token = await resolveToken();
  if (token === exit || token === back) return token;
  if (await getAdditionalModels() === undefined) {
    const choice = await offerAdditionalModels();
    if (choice === back || choice === exit) return choice;
    if (choice === 'models') {
      const result = await configureModels();
      if (result === back || result === exit) return result;
    } else {
      await saveAdditionalModels([]);
    }
  }
  await runHarness(harness, token, await getHarnessStrategy(harness));
  await persistToken(token);
}

async function configureSettings(harness) {
  const strategy = await getHarnessStrategy(harness);
  const saved = await getAdditionalModels() || [];
  const models = modelsForHarness(saved, harness);
  const selected = await chooseAgentSettings(harness, strategy, {
    gateway: process.env.APIHUB_GATEWAY?.trim() || defaultGateway, model, tokenHelpUrl, models, saved,
  });
  if (selected === exit || selected === back) return selected;
  await saveHarnessStrategy(harness, selected);
}

async function configureModels() {
  const saved = await getAdditionalModels() || [];
  let offline = false;
  const catalog = await withProgress('Загружаем каталог APIHub', () => fetchModelCatalog()).catch((error) => {
    if (!saved.length) throw error;
    offline = true;
    return [];
  });
  const selected = await chooseAdditionalModels(catalog, saved, { offline });
  if (selected === back || selected === exit) return selected;
  await saveAdditionalModels(selected);
  console.log(`Дополнительные модели сохранены · ${selected.length}`);
}

async function configure() {
  const detected = await withProgress('Ищем установленные агенты', detectHarnesses);
  let previousAgent;
  while (true) {
    const agent = await chooseAgent(detected, previousAgent);
    if (agent === back || agent === exit) return agent;
    const harness = detected.find(({ value }) => value === agent);
    previousAgent = agent;
    while (true) {
      const action = await chooseAgentAction(harness);
      if (action === exit) return exit;
      if (action === back) break;
      if (action === 'settings') {
        if (await configureSettings(harness) === exit) return exit;
        continue;
      }
      if (action === 'restore') {
        const restoration = await prepareRestoration(agent);
        if (restoration.apply) {
          const confirm = await confirmRestore(`${harness.label} · Восстановить настройки\n${restoration.message}`);
          if (confirm === exit) return exit;
          if (confirm === back) continue;
          process.stdout.write('\n');
          const message = await withProgress(`Восстанавливаем настройки ${harness.label}`, restoration.apply);
          console.log(color('success', message));
        } else {
          process.stdout.write('\n');
          console.log(restoration.message);
        }
        return;
      }
      const result = await configureLaunch(harness);
      if (result !== back) return result;
    }
  }
}

async function interactive() {
  if (!process.stdin.isTTY) {
    const agent = process.env.APIHUB_AGENT;
    if (!agent) throw new Error(`Для запуска без TUI задайте APIHUB_AGENT. Доступные значения: ${supported.join(', ')}.`);
    const harness = (await detectHarnesses()).find(({ value }) => value === agent);
    if (!harness?.available) throw new Error(harness ? `${harness.label}: ${harness.note}.` : `Неизвестный кодинг-агент: ${agent}.`);
    const token = await resolveToken();
    await runHarness(harness, token, process.env.APIHUB_STRATEGY || await getHarnessStrategy(harness));
    await persistToken(token);
    return;
  }
  while (true) {
    const mode = await chooseMode();
    if (mode === exit) return;
    try {
      if (mode === 'change-key') {
        const token = await resolveToken({ replace: true });
        if (token === exit) return;
        if (token === back) continue;
        await persistToken(token);
        console.log(color('success', 'Ключ сохранён.'));
      } else if (mode === 'models') {
        const result = await configureModels();
        if (result === exit) return;
        continue;
      } else if (mode === 'marketplace') {
        const question = await askMarketplaceQuestion();
        if (question === exit) return;
        if (question === back) continue;
        console.log(marketplaceLinks(question).join('\n\n'));
      } else {
        const result = await configure();
        if (result === exit) return;
        if (result === back) continue;
      }
    } catch (error) {
      console.error(color('error', `APIHub: ${error.message}`, process.stderr));
    }
    const result = await returnToMenu();
    if (result === exit) return;
  }
}

try {
  const args = process.argv.slice(2);
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log('apihub-auto-setup — настройка и запуск кодинг-агентов через APIHub Auto.');
    console.log(`APIHUB_AGENT: ${supported.join(', ')}.`);
  } else if (args.length === 1 && args[0] === '--restore') {
    await restore();
  } else if (args.length === 0) {
    await interactive();
  } else {
    throw new Error('Запустите установщик без аргументов или с --restore.');
  }
} catch (error) {
  console.error(color('error', `APIHub: ${error.message}`, process.stderr));
  process.exitCode = 1;
}
