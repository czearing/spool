[CmdletBinding()]
param(
    [string[]]$CodespaceConfigurations = @(),
    [string]$ReviewConfiguration,
    [string]$NodeExecutable = (Get-Command node -ErrorAction Stop).Source
)
$ErrorActionPreference = 'Stop'
if (!$CodespaceConfigurations.Count -and !$ReviewConfiguration) {
    throw 'Register at least one existing engineering or reviewer Codespace configuration. Local Scalar/WSL profiles are not supported.'
}
$NodeExecutable = (Resolve-Path -LiteralPath $NodeExecutable).Path
$profile = @{ version = 1 }
if ($CodespaceConfigurations.Count) {
    $profile.codespaceWorkspaces = @($CodespaceConfigurations | ForEach-Object { (Resolve-Path -LiteralPath $_).Path })
}
if ($ReviewConfiguration) {
    $profile.codespaceReview = (Resolve-Path -LiteralPath $ReviewConfiguration).Path
}
$validate = @'
import {readCodespaceConfig} from "./src/codespaces/config.mjs";
const profile=JSON.parse(process.argv[1]);
const engineering=(profile.codespaceWorkspaces||[]).map(readCodespaceConfig);
const reviewer=profile.codespaceReview?readCodespaceConfig(profile.codespaceReview):null;
if(engineering.some(config=>config.purpose!=="engineering"))throw Error("Expected an engineering Codespace");
if(reviewer?.purpose==="engineering")throw Error("Expected a reviewer Codespace");
if(new Set(engineering.map(config=>config.workspace)).size!==engineering.length||
   new Set(engineering.map(config=>config.codespace)).size!==engineering.length||
   engineering.some(config=>config.workspace===reviewer?.workspace||config.codespace===reviewer?.codespace))
  throw Error("Engineering Codespaces must be distinct from each other and the reviewer");
'@
Push-Location $PSScriptRoot
try {
    & $NodeExecutable --input-type=module -e $validate ($profile | ConvertTo-Json -Depth 10 -Compress)
    if ($LASTEXITCODE -ne 0) { throw 'Codespace registration validation failed; no files were changed.' }
} finally { Pop-Location }
$homeDirectory = if ($env:COPILOT_HOME) { $env:COPILOT_HOME } else { Join-Path $HOME '.copilot' }
$configurationFile = Join-Path $homeDirectory 'mcp-config.json'
$config = if (Test-Path -LiteralPath $configurationFile) {
    Get-Content -LiteralPath $configurationFile -Raw | ConvertFrom-Json -AsHashtable
} else { @{} }
if (!$config.ContainsKey('mcpServers')) { $config.mcpServers = @{} }
$entry = Join-Path $PSScriptRoot 'src\index.mjs'
if ($config.mcpServers.ContainsKey('repository') -and $config.mcpServers.repository.args[-1] -ne $entry) {
    throw 'A different repository MCP is already registered; automatic replacement refused.'
}
function Save-Configuration([string]$File, $Value) {
    $temporary = "$File.$([guid]::NewGuid().ToString('N')).tmp"
    $Value | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $temporary -Encoding utf8NoBOM
    Move-Item -LiteralPath $temporary -Destination $File -Force
}
New-Item -ItemType Directory -Path $homeDirectory -Force | Out-Null
$profileFile = Join-Path $homeDirectory 'repository-mcp.json'
Save-Configuration $profileFile $profile
$config.mcpServers.repository = @{
    type = 'local'
    command = $NodeExecutable
    args = @($entry)
    tools = @('repo_prepare', 'repo_build', 'repo_check', 'repo_pr')
    timeout = 5400000
    env = @{ REPOSITORY_MCP_CONFIG = $profileFile }
}
Save-Configuration $configurationFile $config
Write-Output 'Registered Codespaces-only 1JS execution. Bohemia settings and running processes were not changed.'
