param([string]$Root = $PSScriptRoot, [string]$Binary = (Join-Path $Root 'target\release\spool.exe'))
$ErrorActionPreference = 'Stop'
if (-not (Test-Path Env:SPOOL_INTERACTIVE_ACP)) { $env:SPOOL_INTERACTIVE_ACP = '1' }
$runtime = Join-Path $Root '.runner'
New-Item -ItemType Directory -Path $runtime -Force | Out-Null
Set-Location $Root
& $Binary --root $Root daemon >> (Join-Path $runtime 'daemon.log') 2>&1
if ($LASTEXITCODE -ne 0) { throw "Spool exited with code $LASTEXITCODE" }
