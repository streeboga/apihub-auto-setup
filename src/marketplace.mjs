const hub = 'https://hub.gnzs.pro';

const topics = [
  { matches: /\bmcp\b|мсп|коннектор|интеграц|connector/u,
    label: 'Подключить MCP в организации', path: '/app/connectors' },
  { matches: /\b(mcp|tools?)\b|инструмент/u,
    label: 'Найти готовый инструмент', path: '/app/tools' },
  { matches: /агент|\bagents?\b/u,
    label: 'Создать или настроить агента', path: '/app/agents' },
  { matches: /продав|поставщ|выстав|опубликов|свой api|мои api|\b(vendor|seller|publish)\b/u,
    label: 'Выставить API или открыть список своих API', path: '/app/vendor/apis' },
  { matches: /как стать|зарегистрир|оформ|поставщ|\b(onboarding|seller)\b/u,
    label: 'Зарегистрироваться как поставщик', path: '/app/onboarding' },
  { matches: /\b(keys?|tokens?)\b|(?<!\p{L})(?:токен|ключ)/u, label: 'Выпустить ключ APIHub', path: '/app/keys' },
  { matches: /расход|дорог|стоит|стоим|дороже|цена|списал|\b(cost|spend|usage)\b/u,
    label: 'Открыть расходы по вызовам', path: '/app/spend' },
  { matches: /роут|маршрут|фоллбэк|\b(routing|fallback)\b/u,
    label: 'Настроить правила маршрутизации организации', path: '/app/org/routing' },
  { matches: /каталог|модел|\b(models?|catalog)\b/u, label: 'Посмотреть каталог моделей', path: '/models' },
];

export function marketplaceLinks(question) {
  const text = question.toLowerCase();
  const found = topics.filter(({ matches }) => matches.test(text));
  return (found.length ? found : topics).map(({ label, path }) => `${label}\n${hub}${path}`);
}
