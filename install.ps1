$setup = Join-Path ([System.IO.Path]::GetTempPath()) "apihub-setup-$([guid]::NewGuid()).exe"
$url = 'https://github.com/streeboga/apihub-setup/releases/download/v0.1.0/apihub-setup-windows-amd64.exe'
$previousToken = $env:APIHUB_TOKEN

try {
    $secret = Read-Host 'Вставьте токен APIHub и нажмите Enter' -AsSecureString
    $token = [System.Net.NetworkCredential]::new('', $secret).Password
    if (-not $token) { throw 'Для настройки нужен токен APIHub.' }

    Invoke-WebRequest -Uri $url -UseBasicParsing -OutFile $setup -ErrorAction Stop
    $env:APIHUB_TOKEN = $token
    & $setup
    if ($LASTEXITCODE -ne 0) { throw "Настройщик завершился с кодом $LASTEXITCODE." }

    $env:APIHUB_API_KEY = $token
} finally {
    $env:APIHUB_TOKEN = $previousToken
    Remove-Item -LiteralPath $setup -ErrorAction SilentlyContinue
}
