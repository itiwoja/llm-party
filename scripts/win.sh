#!/usr/bin/env bash
# WSL で書いたソースを Windows へ写して、Windows の Node で起動する（D-86）。npm run win から呼ぶ
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
windows_root=$(cd /mnt/c && cmd.exe /c 'echo %LOCALAPPDATA%' 2>/dev/null | tr -d '\r')
root=$(wslpath -u "$windows_root")/llm-party
app=$root/app
mkdir -p "$app"

# node_modules は Windows 用のものを Windows 側に持つので写さない。除外したものは --delete でも消えない
rsync -rt --delete --exclude node_modules --exclude dist --exclude data --exclude .git --exclude .claude --exclude .npm-lock-hash "$repo/" "$app/"

# 依存が変わったときだけ入れ直す
lock_hash=$(sha256sum "$repo/package-lock.json" | cut -d' ' -f1)
if [ ! -d "$app/node_modules" ] || [ "$(cat "$app/.npm-lock-hash" 2>/dev/null)" != "$lock_hash" ]; then
  # better-sqlite3 は Windows 用の本体を同梱している。スクリプトを動かすと Visual Studio が要るビルドが走る
  (cd "$app" && cmd.exe /c 'npm ci --ignore-scripts')
  printf '%s' "$lock_hash" > "$app/.npm-lock-hash"
fi

run_ps1() { (cd "$app" && powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "scripts/$1"); }

# WSL 側で Ctrl+C しても Windows の Node は残るので、起動の前と終わるときに止める
run_ps1 win-stop.ps1
trap 'run_ps1 win-stop.ps1' EXIT
run_ps1 win-start.ps1
