# Detached runner for the cold passes: idle 20 min, cold pass, idle 20 min, cold pass.
# Launched via Start-Process so it outlives any tool-call timeout. Progress goes to cold.log.
$ErrorActionPreference = 'Continue'
Set-Location $PSScriptRoot
$log = Join-Path $PSScriptRoot 'cold.log'
function Log($m) { "$((Get-Date).ToUniversalTime().ToString('HH:mm:ssZ')) $m" | Out-File -FilePath $log -Append -Encoding utf8 }
Log '=== runner started; idle 20 min'
Start-Sleep -Seconds 1200
Log '=== cold cli-first'
& bun run bench.ts cold cli-first 2>&1 | Out-File -FilePath $log -Append -Encoding utf8
Log '=== idle 20 min'
Start-Sleep -Seconds 1200
Log '=== cold direct-first'
& bun run bench.ts cold direct-first 2>&1 | Out-File -FilePath $log -Append -Encoding utf8
Log '=== all done'
