# APIHub Auto Setup

Открытый настройщик Claude Code CLI для macOS, Windows и Linux. Нужен Node.js 22.19+.
Сборка бинарника и сертификат Apple не требуются.

## Установка

```sh
git clone https://github.com/streeboga/apihub-auto-setup.git
cd apihub-auto-setup
```

Передайте свой API-ключ APIHub через переменную окружения `APIHUB_TOKEN`.
Получить ключ можно в [кабинете APIHub](https://hub.gnzs.pro/app/tokens).

## Настройка с Pi

```sh
npm ci --ignore-scripts
node setup.mjs --dry-run --agent "Настрой Claude Code на минимальную цену"
node setup.mjs --apply --agent "Настрой Claude Code на минимальную цену"
```

Pi получает вашу просьбу через шлюз APIHub, используя модель `apihub-auto` и режим `reliable`.
Ключ передаётся в заголовке запроса. Единственный инструмент Pi предлагает один из четырёх
режимов Claude Code. Сохранение настроек выполняет скрипт при запуске с `--apply`.
С `--dry-run --agent` выполняется один запрос к шлюзу и показывается результат.

## Ручная настройка

```sh
node setup.mjs --dry-run --strategy cheaper
node setup.mjs --apply --strategy cheaper
node setup.mjs --restore
```

Ручной режим работает без установки npm-зависимостей и запросов к шлюзу.
Стратегии `optimal`, `cheaper`, `faster` и `reliable` соответствуют балансу, цене,
скорости и надёжности. По умолчанию используется `optimal`.

Скрипт редактирует `~/.claude/settings.json` или файл в `CLAUDE_CONFIG_DIR`.
Предыдущие настройки сохраняются в соседнем файле, если они уже были.
После настройки запустите новую сессию Claude Code.

Claude Code отправляет `apihub-auto` и заголовок `X-APIHub-Strategy` на шлюз.
Шлюз выбирает фактическую модель, продавца и резерв. На выбранном шлюзе
должен быть включён маршрут `apihub-auto`. Графическое приложение Claude Desktop
использует отдельную конфигурацию.

## Проверка

```sh
npm ci --ignore-scripts
npm test
```

Тесты поднимают локальный стенд с протоколом Anthropic Messages.
Для проверки установленного Claude Code передайте путь к нему в `CLAUDE_CODE_SMOKE`.
