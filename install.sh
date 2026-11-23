#!/usr/bin/env bash

# Source this script so Codex can use the key in the current terminal.
_apihub_install() {
  unset -f _apihub_install
  local target token

  case "$(uname -sm)" in
    'Darwin arm64') target=darwin-arm64 ;;
    'Darwin x86_64') target=darwin-amd64 ;;
    'Linux aarch64'|'Linux arm64') target=linux-arm64 ;;
    'Linux x86_64') target=linux-amd64 ;;
    *) printf 'Для этой системы нет готового установщика.\n' >&2; return 1 ;;
  esac

  printf 'Вставьте токен APIHub и нажмите Enter: ' >/dev/tty || return 1
  IFS= read -rs token </dev/tty || token=
  printf '\n' >/dev/tty
  if [ -z "$token" ]; then
    printf 'Для настройки нужен токен APIHub.\n' >&2
    return 1
  fi

  (
    dir=$(mktemp -d) || exit 1
    trap 'rm -f "$dir/apihub-setup"; rmdir "$dir"' EXIT

    url="https://github.com/streeboga/apihub-setup/releases/download/v0.1.0/apihub-setup-$target"
    curl -fsSL "$url" -o "$dir/apihub-setup" &&
      chmod 700 "$dir/apihub-setup" &&
      APIHUB_TOKEN="$token" "$dir/apihub-setup"
  ) || return

  export APIHUB_API_KEY="$token"
}

_apihub_install
