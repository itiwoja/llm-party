# Windows で動いている LLM-PARTY の worker を子プロセスごと止める。worker が居なければ何もしない
$app = Join-Path $env:LOCALAPPDATA 'llm-party\app'
Get-CimInstance Win32_Process -Filter "name='node.exe'" |
  Where-Object { $_.CommandLine -like "*$app*" -and $_.CommandLine -like '*server/local.ts*' } |
  ForEach-Object { taskkill /PID $_.ProcessId /T /F 2>$null | Out-Null }
exit 0
