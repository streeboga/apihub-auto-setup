# APIHub для кодинг-агентов

Подключите модели APIHub к своему Claude Code, Codex или OpenCode. Продолжайте работать в привычном агенте и оплачивайте запросы с одного баланса APIHub.

## Быстрый старт

1. [Зарегистрируйтесь в APIHub](https://hub.gnzs.pro/register?utm_source=github&utm_medium=readme&utm_campaign=apihub-auto-setup). Первые запросы можно оплатить стартовым бонусом, который APIHub начисляет при регистрации.
2. [Создайте и скопируйте токен](https://hub.gnzs.pro/app/tokens?utm_source=github&utm_medium=readme&utm_campaign=apihub-auto-setup).
3. Запустите команду ниже. Когда терминал попросит токен, вставьте его и нажмите Enter. Настройщик найдёт поддерживаемые приложения по их файлам настроек и подключит их к APIHub. Откройте новую сессию в агенте.

Можно попросить об этом агента, в котором вы уже работаете. Отправьте ему ссылку на этот README и сообщение.

> Подключи APIHub по инструкции из README. Покажи команду для моего терминала и подскажи, как запустить мой агент после настройки. Токен я введу в терминале.

Команда для macOS, Linux и Windows (x64). Нужен Node.js 22.19 или новее.

```sh
npx apihub-auto-setup
```

## После настройки

- **Claude Code.** Запустите `claude`.
- **Codex.** Запустите `codex`. Установщик сохранит токен в локальных настройках провайдера APIHub.
- **OpenCode.** Если вы раньше выбрали модель другого провайдера, переключитесь на APIHub через `/models`.
- **Cursor, Continue, Aider и Cline.** Перезапустите свой инструмент, чтобы он перечитал настройки.

Перед записью Go-настройщик сохраняет копии существующих настроек. Описание параметров и восстановления есть в [репозитории apihub-setup](https://github.com/streeboga/apihub-setup?utm_source=github&utm_medium=readme&utm_campaign=apihub-auto-setup).

[Открыть APIHub](https://hub.gnzs.pro/?utm_source=github&utm_medium=readme&utm_campaign=apihub-auto-setup)
