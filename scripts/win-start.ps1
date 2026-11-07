# Windows の Node で LLM-PARTY を起動する。WSL からは npm run win で呼ばれる。Windows から直接実行してもよい
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:LOCALAPPDATA 'llm-party'
Set-Location (Join-Path $root 'app')

$env:LLM_PARTY_DATA_DIR = $root
$env:LLM_PARTY_SD_BIN = Join-Path $root 'runtime\sd\sd-cli.exe'
$env:NODE_ENV = 'production'

npm run build
if ($LASTEXITCODE) { exit $LASTEXITCODE }
node node_modules/tsx/dist/cli.mjs server/local.ts
exit $LASTEXITCODE
