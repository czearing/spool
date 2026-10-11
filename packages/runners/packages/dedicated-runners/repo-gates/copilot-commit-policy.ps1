[CmdletBinding()]
param(
  [Parameter(Mandatory)][string] $RepoRoot,
  [switch] $InstallHook
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path -LiteralPath $RepoRoot).ProviderPath
$gitRoot = & git -C $root rev-parse --show-toplevel
if ($LASTEXITCODE -ne 0) { throw "Cannot resolve Git repository root: $root" }
$prefix = & git -C $root rev-parse --show-prefix
if ($LASTEXITCODE -ne 0 -or -not [string]::IsNullOrEmpty($prefix)) {
  throw "Commit policy configuration requires a Git repository root: $root"
}
$root = [IO.Path]::GetFullPath($gitRoot)

Write-Output "Copilot attribution is controlled by includeCoAuthoredBy in CLI user settings, not repository-local settings."
if (-not $InstallHook) { return }

$hookDirectory = & git -C $root rev-parse --path-format=absolute --git-path hooks
if ($LASTEXITCODE -ne 0) { throw "Cannot resolve repository hooks directory" }
$hook = Join-Path $hookDirectory "commit-msg"
$marker = "# bohemia-gate: no AI attribution in commit messages"
if ((Test-Path -LiteralPath $hook) -and (Get-Content -LiteralPath $hook -Raw) -notlike "*$marker*") {
  Write-Output "Existing custom commit-msg hook left unchanged; publish validation still enforces the policy."
  return
}
$body = @"
#!/bin/sh
$marker
# Installed by the repository preparation runner.
found=""
while IFS= read -r line || [ -n "`$line" ]; do
  case "`$line" in
    *[Cc]o-authored-by:*[Cc]opilot* | *[Cc]o-authored-by:*[Cc]laude* | \
    *[Cc]o-authored-by:*ChatGPT* | *[Cc]o-authored-by:*[Cc]ursor* | \
    [Cc]opilot-[Ss]ession:*)
      found="`$found
  `$line" ;;
  esac
done < "`$1"
if [ -n "`$found" ]; then
  echo "COMMIT_MESSAGE_POLICY: recoverable message validation failure." >&2
  echo "This commit message credits an AI tool. Remove these lines and commit again:`$found" >&2
  echo "Correct the message only. Keep the hook enabled; do not change repository policy or request an exception." >&2
  echo "If Copilot keeps adding attribution, configure includeCoAuthoredBy=false in CLI user settings before the next invocation; repository-local settings do not support this option." >&2
  exit 1
fi
"@
[IO.Directory]::CreateDirectory($hookDirectory) | Out-Null
[IO.File]::WriteAllText($hook, $body.Replace("`r`n", "`n") + "`n", [Text.Encoding]::ASCII)
Write-Output "Commit policy hook installed; rejection classified as recoverable message validation."
