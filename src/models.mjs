import { model as autoModel } from './setup.mjs';

const catalogUrl = 'https://hub.gnzs.pro/api/v1/storefront/models?type=chat';
const protocols = {
  chat_completions: '/chat/completions', messages: '/messages', responses: '/responses',
};
const routePaths = Object.values(protocols);
const modelId = /^[a-z0-9][a-z0-9._:/+-]{0,159}$/i;

function label(value) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, 100) : '';
}

export function normalizeModels(entries) {
  const models = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const id = entry?.id;
    if (typeof id !== 'string' || !modelId.test(id) || id === autoModel || models.has(id)) continue;
    models.set(id, {
      id, name: label(entry.name) || id, maker: label(entry.maker),
      context: Number.isSafeInteger(entry.context) && entry.context > 0 ? entry.context : undefined,
      paths: routePaths.filter((path) => Array.isArray(entry.paths) && entry.paths.includes(path)),
    });
  }
  return [...models.values()];
}

function pathProtocol(path) {
  return typeof path === 'string' && routePaths.find((endpoint) => path.endsWith(endpoint));
}

export async function fetchModelCatalog(url = process.env.APIHUB_CATALOG_URL || catalogUrl) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Каталог моделей APIHub недоступен (HTTP ${response.status}).`);
  const { data } = await response.json();
  if (!Array.isArray(data)) throw new Error('Каталог APIHub вернул неверный список моделей.');
  return normalizeModels(data.filter((item) => item?.type === 'chat' && item.path &&
    Array.isArray(item.offers) && item.offers.some((offer) => offer && !offer.unavailable)).map((item) => {
    const paths = Array.isArray(item.protocols)
      ? item.protocols.map((value) => protocols[value] || value)
      : [pathProtocol(item.path), ...item.offers.filter((o) => o && !o.unavailable).map((o) => pathProtocol(o.direct?.path))];
    return { id: item.key, name: item.name, maker: item.maker, context: item.context_length, paths };
  })).filter(({ paths }) => paths.length > 0).sort((a, b) => a.name.localeCompare(b.name));
}

export function searchModels(models, term) {
  const words = term.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return models.filter(({ id, name, maker }) => {
    const haystack = `${id} ${name} ${maker}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

export function modelsForHarness(models, harness) {
  return models.filter(({ paths }) => paths.includes(harness.endpoint));
}
