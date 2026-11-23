# APIHub для кодинг-агентов

Подключите модели APIHub к своему Claude Code, Codex или OpenCode. Продолжайте работать в привычном агенте и оплачивайте запросы с одного баланса APIHub.

## Быстрый старт

1. [Зарегистрируйтесь в APIHub](https://hub.gnzs.pro/register?utm_source=github&utm_medium=readme&utm_campaign=apihub-auto-setup). Первые запросы можно оплатить стартовым бонусом, который APIHub начисляет при регистрации.
2. [Создайте и скопируйте токен](https://hub.gnzs.pro/app/tokens?utm_source=github&utm_medium=readme&utm_campaign=apihub-auto-setup).
3. Запустите команду для своей системы. Когда терминал попросит токен, вставьте его и нажмите Enter. Настройщик найдёт поддерживаемые приложения по их файлам настроек и подключит их к APIHub. Откройте новую сессию в агенте.

Можно попросить об этом агента, в котором вы уже работаете. Отправьте ему ссылку на этот README и сообщение.

> Подключи APIHub по инструкции из README. Определи мою систему, подготовь команду для моего терминала и подскажи, как запустить мой агент после настройки. Токен я введу в терминале.

### macOS и Linux

Скопируйте блок целиком. Он скачает нужную версию настройщика и попросит токен. При вставке токен на экране не появится.

```bash
setup_apihub() {
  local apihub_token
  printf 'Вставьте токен APIHub и нажмите Enter: '
  IFS= read -rs apihub_token || return 1
  printf '\n'
  [ -n "$apihub_token" ] || return 1
  (
    case "$(uname -sm)" in
      'Darwin arm64') target=darwin-arm64 ;;
      'Darwin x86_64') target=darwin-amd64 ;;
      'Linux aarch64'|'Linux arm64') target=linux-arm64 ;;
      'Linux x86_64') target=linux-amd64 ;;
      *) printf 'Для этой системы нет готового файла настройки.\n' >&2; exit 1 ;;
    esac
    dir=$(mktemp -d) || exit 1
    trap 'rm -f "$dir/apihub-setup"; rmdir "$dir"' EXIT
    url="https://github.com/streeboga/apihub-setup/releases/download/v0.1.0/apihub-setup-$target"
    curl -fsSL "$url" -o "$dir/apihub-setup" &&
    chmod +x "$dir/apihub-setup" &&
    APIHUB_TOKEN="$apihub_token" "$dir/apihub-setup"
  ) && export APIHUB_API_KEY="$apihub_token"
}
setup_apihub; unset -f setup_apihub
```

### Windows (x64)

Вставьте этот блок в PowerShell.

```powershell
$setup = Join-Path ([System.IO.Path]::GetTempPath()) "apihub-setup-$([guid]::NewGuid()).exe"
$url = 'https://github.com/streeboga/apihub-setup/releases/download/v0.1.0/apihub-setup-windows-amd64.exe'
$previousToken = $env:APIHUB_TOKEN
try {
    Invoke-WebRequest -Uri $url -OutFile $setup -ErrorAction Stop
    $token = Read-Host 'Вставьте токен APIHub и нажмите Enter' -AsSecureString
    $env:APIHUB_TOKEN = [System.Net.NetworkCredential]::new('', $token).Password
    if ($env:APIHUB_TOKEN) {
        & $setup
        if ($LASTEXITCODE -eq 0) { $env:APIHUB_API_KEY = $env:APIHUB_TOKEN }
    }
} finally {
    $env:APIHUB_TOKEN = $previousToken
    Remove-Variable token, previousToken -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $setup -ErrorAction SilentlyContinue
}
```

## После настройки

- **Claude Code.** Запустите `claude`.
- **Codex.** Запустите `codex` в том же терминале, где вводили токен. В новом терминале задайте `APIHUB_API_KEY` перед запуском.
- **OpenCode.** Если вы раньше выбрали модель другого провайдера, переключитесь на APIHub через `/models`.
- **Cursor, Continue, Aider и Cline.** Перезапустите свой инструмент, чтобы он перечитал настройки.

Перед записью Go-настройщик сохраняет копии существующих настроек. Описание параметров и восстановления есть в [репозитории apihub-setup](https://github.com/streeboga/apihub-setup?utm_source=github&utm_medium=readme&utm_campaign=apihub-auto-setup).

[Открыть APIHub](https://hub.gnzs.pro/?utm_source=github&utm_medium=readme&utm_campaign=apihub-auto-setup)
