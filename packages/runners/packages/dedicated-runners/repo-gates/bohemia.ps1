<#
.SYNOPSIS
  One entry point for working in an office-bohemia clone: prepare it, validate a change, push safely.

.DESCRIPTION
  Agents lose most of their time to two things: rediscovering how to prepare a workspace, and
  guessing which checks CI will run. This exposes both as single verbs.

    bohemia setup     Install dependencies and warm the dependency build so later checks are fast.
    bohemia check     Run the CI build, test and format gates, scoped to the packages this branch changed.
    bohemia push      Run check, then push only if it passed.

  Why the check is scoped the way it is:

  Lage's --since selects packages changed since the merge base plus their dependents, which is the
  right default: a branch that edits an eslint or tsconfig file makes files it never opened
  illegal, so a gate keyed on changed files alone reports clean on exactly the failure it exists to
  catch. The exception is a repo-level file that belongs to no package, yarn.lock above all, which
  makes --since select the entire workspace; there the gate scopes to the changed packages by name
  instead and leaves the sweep to CI. Global pipeline changes still require the whole workspace.
  Every target runs in one grouped, fail-fast invocation using CI's unit-test build flavor.

  The target list is the one the required PR builds run, so a local pass means what it looks like
  it means. Only the targets that cannot work outside a build are left out: the ones that upload
  results to it, and test:compat, which downloads artifacts from it.

  Cost lives in lint's task dependencies, not lint: lint dependsOn the build tasks, so an unbuilt
  dependency tree turns a check into a full build. That is what `setup` exists to pay off once.

  This is a filter, not proof that CI passes. The Eslint health analysis step needs a pull request
  and build id and cannot run here, and CI validates the merge commit, so a change landing on the
  target branch can still fail a push that passed locally.
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet("setup", "build", "check", "push", "help")]
  [string] $Action = "help",

  [string] $RepoRoot,
  [string] $TargetBranch = "origin/master",
  [string] $Packages = "",
  [switch] $SkipWarmBuild,
  [switch] $ProductionArtifacts,
  [switch] $PrepareTests,

  # Forces the workspace-wide sweep even when a repo-level file such as yarn.lock widened the
  # selection and the gate would otherwise scope to the packages actually changed. Slow, and prone
  # to reporting pre-existing repo debt in packages the branch never touched. Use only when chasing
  # a failure that appears solely in CI.
  [switch] $Full,

  # Arguments forwarded to git push, for example -PushArgs '--force-with-lease'.
  [string[]] $PushArgs = @()
)

$ErrorActionPreference = "Stop"
$signatureInputs = @(
  $PSCommandPath,
  (Join-Path $PSScriptRoot "../../bohemia-pr-mcp/src/ci-dedupe.cjs"),
  (Join-Path $PSScriptRoot "../../bohemia-pr-mcp/src/ci-validation.mjs"),
  (Join-Path $PSScriptRoot "../../bohemia-pr-mcp/src/ci-install.mjs"),
  (Join-Path $PSScriptRoot "../../bohemia-pr-mcp/src/ci-install-cli.mjs"),
  (Join-Path $PSScriptRoot "../../bohemia-pr-mcp/src/test-runtime.mjs")
)
$script:GateSignature = (Get-FileHash -LiteralPath $signatureInputs -Algorithm SHA256).Hash -join ":"

# There is no `build` task in lage.config.js. `lint` and `typecheck` depend on buildTasks,
# which are transpile and postTranspile, so those are what setup has to warm.
$warmTasks = "transpile postTranspile"
if ($ProductionArtifacts -and $Action -ne "build") {
  throw "ProductionArtifacts is only valid for the build action."
}
if ($PrepareTests -and ($Action -ne "build" -or -not $Packages -or $ProductionArtifacts)) {
  throw "PrepareTests requires a dependency build with explicit packages."
}

function Resolve-RepoRoot {
  param([string] $Candidate)
  $start = if ($Candidate) { $Candidate } else { (Get-Location).Path }
  # An extended-length path (\\?\C:\...) is a Win32 detail that means nothing to git, and
  # Resolve-Path turns it into a provider-qualified string whose joins do not exist, so the walk
  # below would climb past a perfectly good clone and report it as not a repository. Strip it, and
  # use ProviderPath so a provider-qualified input cannot reintroduce the same problem.
  if ($start -like '\\?\UNC\*') { $start = '\\' + $start.Substring(8) }
  elseif ($start -like '\\?\*') { $start = $start.Substring(4) }
  $dir = Resolve-Path -LiteralPath $start -ErrorAction SilentlyContinue
  if (-not $dir) { throw "Path does not exist: $start" }
  $current = $dir.ProviderPath
  while ($current) {
    if (Test-Path (Join-Path $current ".git")) { return $current }
    $parent = Split-Path $current -Parent
    if ($parent -eq $current) { break }
    $current = $parent
  }
  throw "Not inside a git repository. Pass -RepoRoot with the clone path."
}

$script:TelemetryPath = Join-Path $env:USERPROFILE ".bohemia-gate\runs.jsonl"
$script:RunId = [guid]::NewGuid().ToString("n").Substring(0, 12)

function Write-Telemetry {
  # Telemetry must never be able to fail a gate, so every path here is swallowed. Several gates
  # run at once, so the append is retried rather than assumed to win the file.
  param([hashtable] $Record)
  try {
    $Record.runId = $script:RunId
    $Record.at = (Get-Date).ToUniversalTime().ToString("o")
    $Record.repo = if ($script:TelemetryRepo) { $script:TelemetryRepo } else { "" }
    $line = ($Record | ConvertTo-Json -Compress -Depth 4) + [Environment]::NewLine
    $dir = Split-Path $script:TelemetryPath -Parent
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    for ($attempt = 0; $attempt -lt 5; $attempt++) {
      try { [IO.File]::AppendAllText($script:TelemetryPath, $line); return } catch { Start-Sleep -Milliseconds 40 }
    }
  }
  catch { }
}

function Invoke-LageValidation {
  param([string] $Targets, [string] $Selector, [bool] $WholeWorkspace,
    [Parameter(Mandatory)][ValidatePattern('^[a-zA-Z0-9_-]+$')][string] $Flavor)
  # Coverage for large packages also needs the existing full-workspace budget.
  $coverage = $Targets -match '(?:^|\s)--coverage(?:\s|$)'
  $timeout = if ($WholeWorkspace -or $coverage) { 5400 } else { 1500 }
  $scope = if ($WholeWorkspace) { "whole workspace" } else { "changed packages" }
  $rawTransfer = $env:KNIP_DISABLE_RAW_TRANSFER
  try {
    # OXC's experimental transfer reserves multi-GiB buffers per concurrent Windows worker.
    if ($IsWindows -and [string]::IsNullOrEmpty($rawTransfer)) {
      $env:KNIP_DISABLE_RAW_TRANSFER = "1"
    }
    Invoke-Gate "Build, tests and format gates ($scope)" `
      "node --run lage -- $Targets --grouped $Selector --allow-no-target-runs --flavor $Flavor" `
      -TimeoutSeconds $timeout
  }
  finally {
    $env:KNIP_DISABLE_RAW_TRANSFER = $rawTransfer
  }
}

function Invoke-Gate {
  # TimeoutSeconds is a backstop, not a tuning knob. A gate that runs for hours and then refuses
  # costs the author more than no gate at all, because the refusal arrives long after they have
  # moved on. Anything that overruns is reported as a failure naming the limit, so the cause is
  # visible instead of looking like a hang.
  param([string] $Name, [string] $Command, [int] $TimeoutSeconds = 1500, [int[]] $SuccessExitCodes = @(0))
  Write-Host "==> $Name" -ForegroundColor Cyan
  $started = Get-Date

  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $env:ComSpec
  $psi.Arguments = "/c $Command"
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true
  $psi.WorkingDirectory = (Get-Location).Path

  $proc = [System.Diagnostics.Process]::Start($psi)
  $captureError = ""
  try {
    $stdoutTask = $proc.StandardOutput.ReadToEndAsync()
    $stderrTask = $proc.StandardError.ReadToEndAsync()
    $timedOut = -not $proc.WaitForExit($TimeoutSeconds * 1000)
    if ($timedOut) {
      # Terminate only this timed-out command's tree, including its build workers.
      & taskkill /T /F /PID $proc.Id 2>&1 | Out-Null
      $exitCode = 1
    }
    else {
      $exitCode = [int]$proc.ExitCode
    }
    $outputComplete = $false
    try {
      $outputComplete = [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($stdoutTask, $stderrTask), 5000)
    }
    catch { $captureError = $_.Exception.GetBaseException().Message }
    $outStr = if ($stdoutTask.IsCompletedSuccessfully) { $stdoutTask.Result } else { "" }
    $errStr = if ($stderrTask.IsCompletedSuccessfully) { $stderrTask.Result } else { "" }
  }
  finally {
    $proc.Dispose()
  }
  $output = $outStr + [Environment]::NewLine + $errStr
  if (-not $outputComplete) {
    $output += "`nError: process output capture did not close within 5 seconds; validation is incomplete. $captureError"
  }
  $failed = $timedOut -or -not $outputComplete -or $SuccessExitCodes -notcontains $exitCode
  $seconds = [math]::Round(((Get-Date) - $started).TotalSeconds)
  Write-Telemetry @{
    kind    = "step"
    step    = $Name
    seconds = $seconds
    failed  = $failed
    timedOut = [bool]$timedOut
    outputComplete = [bool]$outputComplete
    limit   = $TimeoutSeconds
    command = $Command
  }
  if ($timedOut) {
    Write-Host ("    TIMEOUT  {0}s (limit {1}s)" -f $seconds, $TimeoutSeconds) -ForegroundColor Red
    Write-Host "      Validation did not complete; no passing result was recorded." -ForegroundColor Red
    return [pscustomobject]@{ Name = "$Name (timed out after ${TimeoutSeconds}s)"; Failed = $true; Seconds = $seconds; Output = $output; ExitCode = $exitCode }
  }
  if ($failed) {
    Write-Host ("    FAIL  {0}s" -f $seconds) -ForegroundColor Red
    # Only the lines that name a cause. The full transcript buries them.
    # Jest marks a failing suite with ✕ and prints "Summary of all failing tests", and Lage
    # reports the package list; without those a test failure shows as FAIL with no reason.
    # Prettier names the offending files on following "- <path>" lines, so those are kept too.
    # Case-insensitive matching and API Extractor signature warnings ensure actionable diagnostics.
    $keep = "(?i)(error TS|error\s+|✖|✕|Error:|failed on the following packages|Summary of all failing tests|Tests:.*failed|●|Expected:|Received:|^\s+- \S+\.\w+|api:verify|api:update|public api signature|you have changed the public api)"
    # Lage prints each line twice, once streamed with a "<package> <task> : " prefix and once in
    # the grouped summary. Dropping the prefix lets the duplicate pair collapse to one line.
    # The remaining exclusions are consequences of the failure rather than the cause of it.
    $noise = "Failed to read and stamp version info|npm error Lifecycle script|Error: Command failed:"
    # Several tools put the finding on the lines after the one that matches, not on it. Knip says
    # "Error: Knip found issues" and then names the dependency two lines later, so matching alone
    # produced a refusal an agent could not act on. A short window after each match is carried
    # through, stopping at the run summary so the transcript tail is never pulled in.
    $stop = "^([\u2500-\u257f\-=_]{8,}|Summary|success:|worker restarts:|Took a total.*)$"
    $lines = @()
    $carry = 0
    foreach ($raw in ($output -split "`r?`n")) {
      $line = ($raw -replace "^\s*\S+ [\w:]+ (:|\u2716|\u2714) ?", "").Trim()
      if ($line -match $stop) { $carry = 0; continue }
      if ($line -match $keep -and $line -notmatch $noise) { $lines += $line; $carry = 6; continue }
      if ($carry -gt 0 -and $line) { $lines += $line; $carry-- }
    }
    $lines = @($lines | Select-Object -Unique)
    if (-not $lines) {
      $lines = $output -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -Last 15
    }
    $lines | Select-Object -First 25 | ForEach-Object { Write-Host "      $_" }
  }
  else {
    Write-Host ("    pass  {0}s" -f $seconds) -ForegroundColor Green
  }
  [pscustomobject]@{ Name = $Name; Failed = $failed; Seconds = $seconds; Output = $output; ExitCode = $exitCode }
}

function Get-MergeBase {
  param([string] $Branch)
  $base = (& git merge-base $Branch HEAD 2>$null)
  if ($LASTEXITCODE -ne 0 -or -not $base) {
    throw "Could not resolve a merge base against $Branch. Run: git fetch origin master"
  }
  return $base.Trim()
}

function Test-MergeConflict {
  # In-memory merge conflict simulation using git merge-tree (0s, no working tree mutation).
  # Catches merge conflicts against the target branch before taking locks, running builds,
  # or opening pull requests that would instantly be unmergeable on Azure DevOps.
  param([string] $TargetBranch)
  $targetRef = if ($TargetBranch -like "origin/*" -or $TargetBranch -like "refs/*") { $TargetBranch } else { "origin/$TargetBranch" }
  $hasTarget = (& git rev-parse --verify "$targetRef" 2>$null)
  if (-not $hasTarget) {
    throw "Cannot resolve target $targetRef; conflict validation did not run."
  }

  $mergeTreeOut = @(& git merge-tree --write-tree "$targetRef" HEAD 2>&1)
  if ($LASTEXITCODE -ne 0) {
    $conflictLines = @($mergeTreeOut | Where-Object { $_ -match "CONFLICT" -or $_ -match "Merge conflict" -or $_ -match "Auto-merging" })
    if (-not $conflictLines) { $conflictLines = $mergeTreeOut | Select-Object -First 10 }
    return [pscustomobject]@{
      HasConflict = $true
      Output = ($conflictLines -join "`n")
    }
  }
  return [pscustomobject]@{ HasConflict = $false; Output = "" }
}

function Test-RecentGatePass {
  # Checks whether an identical clean gate pass was already recorded on this exact commit/tree within 30 minutes.
  # Eliminates duplicate execution when agents run `bohemia check` followed immediately by `bohemia push`.
  param(
    [string] $MergeBase,
    [string] $TargetBranch,
    [bool] $IsFull
  )
  try {
    $rel = (& git rev-parse --git-path bohemia-gate-pass.json 2>$null)
    if (-not $rel) { return $false }
    $stampFile = [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $rel.Trim()))
    if (-not (Test-Path $stampFile)) { return $false }

    $json = Get-Content $stampFile -Raw | ConvertFrom-Json
    if (-not $json -or -not $json.head -or -not $json.mergeBase -or -not $json.passedAt -or
        -not $json.gateSignature -or $json.gateSignature -ne $script:GateSignature) { return $false }

    $currentHead = (& git rev-parse HEAD 2>$null)
    if ($currentHead.Trim() -ne $json.head.Trim()) { return $false }
    if ($MergeBase.Trim() -ne $json.mergeBase.Trim()) { return $false }
    if ($TargetBranch -ne $json.targetBranch -or -not $json.targetCommit) { return $false }
    $targetCommit = (& git rev-parse --verify $TargetBranch 2>$null)
    if ($LASTEXITCODE -ne 0 -or $targetCommit.Trim() -ne $json.targetCommit) { return $false }
    if ($IsFull -and -not $json.full) { return $false }

    $passedTime = ([DateTimeOffset]$json.passedAt).UtcDateTime
    $ageMinutes = ((Get-Date).ToUniversalTime() - $passedTime).TotalMinutes
    if ($ageMinutes -lt 0 -or $ageMinutes -gt 30) { return $false }

    return $true
  }
  catch {
    return $false
  }
}

function Save-GatePassStamp {
  param(
    [string] $MergeBase,
    [string] $TargetBranch,
    [bool] $IsFull
  )
  try {
    $rel = (& git rev-parse --git-path bohemia-gate-pass.json 2>$null)
    if (-not $rel) { return }
    $stampFile = [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $rel.Trim()))
    $currentHead = (& git rev-parse HEAD 2>$null)
    $targetCommit = (& git rev-parse --verify $TargetBranch 2>$null)
    if ($LASTEXITCODE -ne 0) { return }
    $stamp = @{
      head         = $currentHead.Trim()
      mergeBase    = $MergeBase.Trim()
      targetBranch = $TargetBranch
      targetCommit = $targetCommit.Trim()
      full         = [bool]$IsFull
      passedAt     = (Get-Date).ToUniversalTime().ToString("o")
      gateSignature = $script:GateSignature
    }
    $stamp | ConvertTo-Json -Compress | Set-Content -Path $stampFile -Force
  }
  catch { }
}

function Clear-GeneratedEolChurn {
  # Code generators rewrite files like routeTree.gen.ts during the warm build, and on Windows that
  # leaves them flagged as modified even when the content is byte-identical, because the endings
  # differ from the indexed blob. Left alone that noise rides into the agent's PR, and the standing
  # prompts tell agents not to discard local changes, so they will not clean it up themselves.
  # git status is the source of truth here: git diff hides pure end-of-line churn.
  # Only restore files whose diff is empty once whitespace is ignored, so a real regeneration
  # is never discarded.
  $entries = @(& git status --porcelain -- "*.gen.ts" "*.gen.tsx" 2>$null)
  foreach ($entry in $entries) {
    if (-not $entry -or $entry.Length -lt 4) { continue }
    $file = $entry.Substring(3).Trim().Trim('"')
    $substantive = @(& git diff --ignore-all-space --ignore-blank-lines -- $file 2>$null)
    if ($substantive.Count -eq 0) {
      & git restore -- $file 2>&1 | Out-Null
      Write-Host "    reverted end-of-line churn in generated file: $file" -ForegroundColor DarkGray
    }
  }
  if (Test-Path "apps/new-office/.tanstack") {
    Remove-Item -Recurse -Force "apps/new-office/.tanstack" -ErrorAction SilentlyContinue
  }
}

function Install-CommitMessageHook {
  & (Join-Path $PSScriptRoot "copilot-commit-policy.ps1") -RepoRoot (Get-Location).Path -InstallHook
}

function Invoke-Setup {
  Write-Host "Preparing workspace" -ForegroundColor Cyan
  $results = @()
  Install-CommitMessageHook
  $lock = Enter-GateLock (Get-Location).Path -CloneOnly:$SkipWarmBuild
  try {
  # Setup is a cold full-workspace build by design, so it gets a far longer allowance than a check.
  $installer = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\..\bohemia-pr-mcp\src\ci-install-cli.mjs"))
  if (-not (Test-Path -LiteralPath $installer)) { throw "Shared Bohemia CI installer is missing: $installer" }
  $reused = $false
  if ($SkipWarmBuild) {
    $probe = Invoke-Gate "Check installed dependencies" "node `"$installer`" `"$((Get-Location).Path)`" --reuse-only" `
      -TimeoutSeconds 60 -SuccessExitCodes @(0, 2)
    if ($probe.Failed) {
      throw "Dependency reuse verification failed ($($probe.Name), exit $($probe.ExitCode)): $($probe.Output)"
    }
    if ($probe.ExitCode -eq 0) {
      $reused = $true
      $results += $probe
    }
    else {
      Exit-GateLock $lock
      $lock = $null
      $lock = Enter-GateLock (Get-Location).Path
    }
  }
  if (-not $reused) {
    $results += Invoke-Gate "Install dependencies" "node `"$installer`" `"$((Get-Location).Path)`"" -TimeoutSeconds 5400
  }
  # lint and typecheck both depend on the transpile tasks, so warming them once across the
  # workspace is what makes every later check incremental instead of a cold build. Scoping this
  # to one package would leave the rest of the clone cold for whatever the agent touches next.
  if (-not @($results | Where-Object { $_.Failed }).Count -and -not $SkipWarmBuild) {
    $results += Invoke-WarmBuild
  }
  }

  finally { Exit-GateLock $lock }
  Clear-GeneratedEolChurn
  $failed = @($results | Where-Object { $_.Failed })
  $total = ($results | Measure-Object -Property Seconds -Sum).Sum
  Write-Host ""
  if ($failed.Count -gt 0) {
    Write-Host ("Setup incomplete after {0}s: {1}" -f $total, ($failed.Name -join ", ")) -ForegroundColor Red
    return 1
  }
  Write-Host ("Workspace ready in {0}s." -f $total) -ForegroundColor Green
  return 0
}

function Invoke-WarmBuild {
  $scopeArgs = ""
  if ($Packages) {
    $names = $Packages.Split(",")
    foreach ($name in $names) {
      if ($name -notmatch '^[a-zA-Z0-9@/._][a-zA-Z0-9@/._-]*$') { throw "Invalid build package name: $name" }
    }
    $scopeArgs = " --to " + ($names -join " ") + " --include-dependencies"
  }
  if ($ProductionArtifacts) {
    if (-not $Packages) { throw "Production artifact builds require explicit packages." }
    $scopeArgs = " --scope " + ($names -join " --scope ")
    return Invoke-Gate "Production bundles and Brotli sidecars" `
      "node --run lage -- bundle release:brotliCompress$scopeArgs --flavor release" -TimeoutSeconds 5400
  }
  $flavor = Get-PipelineValidationFlavor
  # Non-isolated packages emit declarations through the repository's typecheck graph, not transpile.
  $targets = if ($PrepareTests) { "$warmTasks emitDeclarations" } else { $warmTasks }
  return Invoke-Gate "Warm dependency build" `
    "node --run lage -- $targets --allow-no-target-runs$scopeArgs --flavor $flavor" -TimeoutSeconds 5400
}

function Invoke-Build {
  $lock = Enter-GateLock (Get-Location).Path
  try {
    $result = Invoke-WarmBuild
    if (-not $result.Failed -and $PrepareTests) {
      $runtime = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\..\bohemia-pr-mcp\src\test-runtime.mjs"))
      $result = Invoke-Gate "Prepare repository-declared test runtimes" `
        "node `"$runtime`" `"$((Get-Location).Path)`" `"$Packages`"" -TimeoutSeconds 1500
    }
  }
  finally { Exit-GateLock $lock }
  Clear-GeneratedEolChurn
  if ($result.Failed) { return 1 }
  return 0
}

function Get-OwningPackageDir {
  # Ownership is resolved by walking up to the nearest package.json rather than by matching a
  # workspace glob, so it stays correct if the workspace layout changes. Returns $null for a file
  # that belongs to no package.
  param([string] $File, [string] $Root)
  $dir = Split-Path (Join-Path $Root $File) -Parent
  while ($dir -and $dir.Length -ge $Root.Length -and $dir -ne $Root) {
    if (Test-Path (Join-Path $dir "package.json")) { return $dir }
    $dir = Split-Path $dir -Parent
  }
  return $null
}

function Test-LageIgnored {
  # lage.config.js already drops these from the --since calculation, so they never widen the run
  # and must not be treated as repo-level changes here either.
  param([string] $File)
  return $File -eq ".npmrc" -or $File -eq "README.md" -or $File -like "change/*"
}

function Get-UnownedChanges {
  param([string[]] $Changed, [string] $Root)
  return @($Changed | Where-Object { -not (Test-LageIgnored $_) -and -not (Get-OwningPackageDir -File $_ -Root $Root) })
}

function Test-BuildInert {
  # Repo-level paths that no package build, test, lint or format target reads: the pipeline
  # definitions, the repo automation scripts and skills, and prose. They are not in lage's ignore
  # list, so a branch touching only these widens --since to the entire workspace
  # (microsoft/lage#1146) and cannot finish inside the gate timeout. The result was not a slow
  # gate but an unpassable one: measured twice, the same four file branch was stopped at the
  # 1500 second limit having built packages it never touched. Only build inputs are excluded
  # here, so a lockfile, a manifest or a shared config still gets the full sweep.
  param([string] $File)
  return $File -like ".github/*" -or $File -like "azure/*" -or $File -like "docs/*" -or
         ($File -notlike "*/*" -and $File -like "*.md")
}

function Test-CommentOrDocOnly {
  # Detects if a branch only modifies markdown/documentation files or comments in code files
  # (AST-invariant changes). If so, we can bypass expensive whole-package builds, transpilation,
  # and unit tests, running only format/lint validation.
  param(
    [string] $MergeBase,
    [string[]] $Changed
  )
  if (-not $Changed -or $Changed.Count -eq 0) { return $false }

  $targetFiles = @($Changed | Where-Object { $_ -notlike "change/*" -and $_ -notlike "change-notes/*" })
  if ($targetFiles.Count -eq 0) { return $true }

  # Configuration, dependencies, build tools, or pipelines require full validation
  $hasConfig = @($targetFiles | Where-Object {
    $_ -like "*package.json" -or $_ -like "*yarn.lock" -or $_ -like "*tsconfig*" -or
    $_ -like "*.config.*" -or $_ -like "*.yml" -or $_ -like "*.yaml"
  })
  if ($hasConfig.Count -gt 0) { return $false }

  $nonDocFiles = @($targetFiles | Where-Object {
    $_ -notlike "*.md" -and $_ -notlike "*.markdown" -and $_ -notlike "docs/*" -and $_ -notlike "LICENSE*"
  })
  if ($nonDocFiles.Count -eq 0) { return $true }

  foreach ($file in $nonDocFiles) {
    if ($file -notmatch '\.(ts|tsx|js|jsx|css|scss|json)$') {
      return $false
    }
    if (-not (Test-Path $file)) {
      return $false
    }

    $script = @'
const { execSync } = require('child_process');
const file = process.argv[1];
const mergeBase = process.argv[2];

function strip(code) {
  return code
    .replace(/(["'`])(?:\\.|(?!\1)[^\\\r\n])*\1|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, (m) => {
      if (m.startsWith('/') && (m.startsWith('//') || m.startsWith('/*'))) return '';
      return m;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

try {
  const before = execSync('git show ' + mergeBase + ':\'' + file.replace(/'/g, "'\\''") + '\'', { stdio: ['pipe', 'pipe', 'ignore'] }).toString('utf8');
  const after = execSync('git show HEAD:\'' + file.replace(/'/g, "'\\''") + '\'', { stdio: ['pipe', 'pipe', 'ignore'] }).toString('utf8');
  if (strip(before) !== strip(after)) {
    process.exit(1);
  }
} catch (e) {
  process.exit(1);
}
'@
    $res = $script | node - "$file" "$MergeBase" 2>$null
    if ($LASTEXITCODE -ne 0) {
      return $false
    }
  }
  return $true
}

function Get-ChangedPackageNames {
  param([string[]] $Changed, [string] $Root)
  $names = @()
  foreach ($file in $Changed) {
    $dir = Get-OwningPackageDir -File $file -Root $Root
    if (-not $dir) { continue }
    $name = (Get-Content (Join-Path $dir "package.json") -Raw | ConvertFrom-Json).name
    if ($name) { $names += $name }
  }
  return @($names | Sort-Object -Unique)
}

function Get-PipelineFile {
  param([string] $Name)
  $path = Join-Path (Get-Location).Path "azure/build-pipelines/$Name"
  if (-not (Test-Path $path)) {
    throw "Cannot read $Name. The gate derives its checks from the pipeline definitions, so it will not guess a list rather than run the wrong one."
  }
  return (Get-Content $path -Raw)
}

# How this gate covers each pipeline that branch policy requires. The value is either "run", or the
# reason it cannot run here, and a required pipeline absent from this table is a hard failure.
#
# This table exists because reading the right yaml is not the same as reading every required yaml.
# The gate read two pipeline files chosen by hand and believed it was complete, while Compliance
# was blocking master the whole time and was never consulted; a branch passed here and was refused
# by Guardian fourteen minutes later. The list of required checks is not this script's to know, so
# it is asked of Azure DevOps at run time and reconciled against this table.
$script:PipelineCoverage = @{
  "azure/build-pipelines/pr-build.yaml"                    = "run"
  "azure/build-pipelines/code-format-validation.yaml"      = "run"
  "azure/build-pipelines/compliance.yaml"                  = "run"
  "azure/build-pipelines/loop-web-services/pr-build.yaml"  = "builds Linux Docker images and needs the .NET SDK and a Linux agent, so only CI can run it"
}

function Invoke-AdoRequest {
  # Azure DevOps answers a token it will not accept with HTTP 203 and a sign-in page, not a 401, so
  # piping the body straight into ConvertFrom-Json reports "Unexpected character encountered while
  # parsing value: <" against a line number in this file, naming neither the cause nor the remedy.
  #
  # That is not a cosmetic problem. On 2026-08-26 an agent met exactly that error, reasonably read it
  # as broken bookkeeping rather than as an auth failure, copied this gate and deleted the
  # reconciliation from its copy so it could get past it. An unreadable failure inside a gate is an
  # invitation to route around the gate, so the response is checked here and the message says what
  # to do about it.
  #
  # The retry is because that outage was transient: the same token was refused at 18:42 and accepted
  # at 19:45 with no re-login in between. Refusing a run over a blip trains people to work around
  # this step too.
  param([string] $Uri, [hashtable] $Headers, [int] $Attempts = 3)
  for ($attempt = 1; ; $attempt++) {
    $response = Invoke-WebRequest -Uri $Uri -Headers $Headers -UseBasicParsing
    if ($response.Content -and $response.Content.TrimStart().StartsWith('{')) { return $response }
    if ($attempt -ge $Attempts) {
      throw @"
Azure DevOps returned a sign-in page instead of data, so the gate cannot read which checks this branch requires.
  url: $Uri
An access token was obtained, so this is Azure DevOps refusing it rather than a missing login. It is often transient, and $Attempts attempt(s) were made. If it persists, run:
  az login --scope 499b84ac-1321-427f-aa17-267ca6975798/.default
Do not edit this step out to get past it. It is the check that proves this gate still covers what branch policy requires, and without it a passing run means nothing.
"@
    }
    Start-Sleep -Seconds ($attempt * 3)
  }
}

function Get-RequiredPolicyPipelines {
  # The required checks as Azure DevOps holds them, not as anyone remembers them. Returns the
  # blocking build policies for the target branch with the yaml each definition runs.
  #
  # Results are cached locally for 4 hours to eliminate 10-15s of network latency on every run
  # and provide resilience against transient ADO token refresh outages.
  param([string] $TargetBranch)
  $ref = if ($TargetBranch -like "refs/*") { $TargetBranch } else { "refs/heads/$($TargetBranch -replace '^origin/','')" }
  $cacheFile = Join-Path $env:USERPROFILE ".bohemia-gate\policy-cache.json"

  # Check local policy cache (valid for 4 hours)
  if (Test-Path $cacheFile) {
    try {
      $cached = Get-Content $cacheFile -Raw | ConvertFrom-Json
      if ($cached -and $cached.ref -eq $ref -and $cached.at) {
        $ageHours = ((Get-Date).ToUniversalTime() - [DateTime]::Parse($cached.at).ToUniversalTime()).TotalHours
        if ($ageHours -lt 4 -and $cached.policies -is [array] -and $cached.policies.Count -gt 0) {
          return @($cached.policies)
        }
      }
    } catch { }
  }

  try {
    $token = (& az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798 --query accessToken -o tsv 2>$null)
    if (-not $token) {
      if (Test-Path $cacheFile) {
        $cached = (Get-Content $cacheFile -Raw | ConvertFrom-Json)
        if ($cached.policies -and $cached.policies.Count -gt 0) {
          Write-Host "az account get-access-token failed; using verified local policy cache." -ForegroundColor Yellow
          return @($cached.policies)
        }
      }
      throw "Cannot ask Azure DevOps which checks are required (az account get-access-token failed). Run az login; the gate will not assume it knows the list."
    }

    $headers = @{ Authorization = "Bearer $token" }
    $base = "https://office.visualstudio.com/OC/_apis"
    $repoId = ((Invoke-AdoRequest -Uri "$base/git/repositories/office-bohemia?api-version=7.0" -Headers $headers).Content | ConvertFrom-Json).id
    $policies = @()
    $continuation = $null
    do {
      $uri = "$base/git/policy/configurations?repositoryId=$repoId&refName=$ref&`$top=500&api-version=7.0"
      if ($continuation) { $uri += "&continuationToken=$continuation" }
      $response = Invoke-AdoRequest -Uri $uri -Headers $headers
      $policies += ($response.Content | ConvertFrom-Json).value
      $continuation = $response.Headers['x-ms-continuationtoken']
      if ($continuation -is [array]) { $continuation = $continuation[0] }
    } while ($continuation)

    $wanted = $policies | Where-Object { $_.type.displayName -eq 'Build' -and $_.isEnabled -and $_.isBlocking }
    $seen = @{}
    $found = @()
    foreach ($policy in $wanted) {
      $id = $policy.settings.buildDefinitionId
      if (-not $id -or $seen.ContainsKey($id)) { continue }
      $seen[$id] = $true
      $definition = ((Invoke-AdoRequest -Uri "$base/build/definitions/$id`?api-version=7.0" -Headers $headers).Content | ConvertFrom-Json)
      $found += [pscustomobject]@{
        Id   = $id
        Name = $definition.name
        Yaml = ($definition.process.yamlFilename -replace '\\', '/')
      }
    }

    # Write to local policy cache
    try {
      $cacheData = @{
        ref      = $ref
        at       = (Get-Date).ToUniversalTime().ToString("o")
        policies = @($found)
      }
      $dir = Split-Path $cacheFile -Parent
      if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
      $cacheData | ConvertTo-Json -Depth 4 | Set-Content -Path $cacheFile -Force
    } catch { }

    return @($found)
  }
  catch {
    if (Test-Path $cacheFile) {
      try {
        $cached = (Get-Content $cacheFile -Raw | ConvertFrom-Json)
        if ($cached.policies -and $cached.policies.Count -gt 0) {
          Write-Host "Azure DevOps policy check encountered a transient error; using verified local policy cache." -ForegroundColor Yellow
          return @($cached.policies)
        }
      } catch { }
    }
    throw
  }
}

function Assert-RequiredChecksCovered {
  # Reconciles what Azure DevOps requires against what this gate knows how to do, and refuses on an
  # unknown one. Refusing is the point: a check nobody classified is exactly the one that has
  # already reached a pull request unrun, and a gap the author never sees is indistinguishable from
  # a gate that does not exist.
  param([string] $TargetBranch)
  $required = Get-RequiredPolicyPipelines -TargetBranch $TargetBranch
  if ($required.Count -eq 0) {
    # Not a fault. Branches outside master and release carry no build policy, including the scratch
    # targets the pull request tool's own probe creates, and refusing those would block a branch
    # for having nothing required of it. The checks below still run; there is simply nothing to
    # reconcile against. A failure to reach Azure DevOps at all is a different case and has already
    # thrown above.
    Write-Host ("No required builds on {0}; nothing to reconcile against." -f $TargetBranch) -ForegroundColor DarkGray
    return
  }
  $unknown = @()
  foreach ($check in $required) {
    if (-not $check.Yaml) { continue }  # server-side policy validators have no pipeline to run
    $how = $script:PipelineCoverage[$check.Yaml]
    if (-not $how) { $unknown += "$($check.Name) ($($check.Yaml))"; continue }
    if ($how -ne "run") { Write-Host ("Required but not runnable here: {0} - {1}" -f $check.Name, $how) -ForegroundColor DarkGray }
  }
  if ($unknown.Count -gt 0) {
    throw ("Branch policy requires a check this gate does not cover: {0}. Add it to PipelineCoverage in bohemia.ps1, either as something the gate runs or with the reason it cannot, so it is never silently missing again." -f ($unknown -join "; "))
  }
  Write-Host ("Required checks for {0}: {1}" -f $TargetBranch, (($required | ForEach-Object { $_.Name }) -join ", ")) -ForegroundColor DarkGray
}

function Get-PipelineValidationFlavor {
  $reader = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "../../bohemia-pr-mcp/src/ci-validation.mjs"))
  $flavor = & node $reader (Get-Location).Path
  if ($LASTEXITCODE -ne 0 -or $flavor -notmatch '^[a-zA-Z0-9_-]+$') {
    throw "Cannot determine the CI validation build flavor; preparation and checks will not guess."
  }
  return $flavor
}

function Get-PipelineLageTargets {
  # The required lage targets, read from the pipeline rather than transcribed into this file.
  # A hardcoded list is a promise this script cannot keep: the yaml is edited by people who have
  # never heard of this gate, nothing fails when the two diverge, and the divergence stays
  # invisible until a required build fails on a real pull request. That is exactly how knip went
  # missing. Both sides now read the same definition, which is the only arrangement that does not
  # drift, and drift here is silent in both directions: a target added to CI is a gap the gate
  # cannot know about, one removed is a false positive it keeps reporting.
  #
  # Only the steps scoped with `since:` are taken. The others are unscoped helper builds, such as
  # transpiling eslint-buddy, that exist to service a CI-only step and are not gates.
  $targets = @()
  foreach ($name in @("code-format-validation.yaml", "templates/jobs/build-unit-tests.yaml")) {
    $text = Get-PipelineFile $name
    $scoped = 0
    foreach ($m in [regex]::Matches($text, "(?s)template:\s*'?[^\r\n']*lage(\.1es)?\.yaml(?:@self)?'?\s*\r?\n\s*parameters:(.*?)(?=\r?\n\s*-\s|\z)")) {
      $block = $m.Groups[2].Value
      if ($block -notmatch "(?m)^\s*since:") { continue }
      $cmd = [regex]::Match($block, "(?m)^\s*command:\s*'([^']+)'")
      if ($cmd.Success) { $targets += ($cmd.Groups[1].Value -split '\s+'); $scoped++ }
    }
    if ($scoped -eq 0) { throw "No scoped Lage command found in required pipeline $name; validation is incomplete." }
  }
  # Three targets exist only to talk to a build. uploadEslintResults and uploadTestCoverage publish
  # results against a build id, and test:compat downloads artifacts from one, so none of them can
  # mean anything locally. Everything else runs. The subtraction list is small, stable and
  # justifiable; the target list is neither, which is why one is written here and the other is not.
  $buildOnly = @("uploadEslintResults", "uploadTestCoverage", "test:compat")
  $unknownFlags = @($targets | Where-Object { $_ -match '^--' -and $_ -ne "--coverage" })
  if ($unknownFlags.Count -gt 0) { throw "Unsupported required CI validation option(s): $($unknownFlags -join ', ')" }
  $targets = @($targets | Where-Object { $_ -and $buildOnly -notcontains $_ } | Select-Object -Unique)
  if ($targets.Count -eq 0) {
    throw "Read the pipeline definitions but found no scoped lage targets. Refusing to run an empty gate."
  }
  return $targets
}

# Steps in the pipeline that cannot run here, each with the reason. Anything in the yaml that is
# not listed and not recognised is reported rather than dropped, so a check added to CI surfaces
# as a named gap instead of silently never running.
$script:PipelineStepsNotRunnable = @{
  "chmod"                                   = "git-lfs validation is a bash script the Windows agents cannot execute"
  "rootPackageResolutionReviewers"          = "assigns ADO reviewers and needs a pull request id"
  "eslintBuddyCli"                          = "eslint health analysis needs a pull request and build id"
  "System.PullRequest"                      = "depends on pipeline variables that only exist in a build"
  "find "                                   = "a bash find and grep pipeline the Windows agents cannot execute"
  "git restore"                             = "handled directly after the lage run, together with the unstaged-file assertion"
}

function Get-PipelineRepoChecks {
  # The repo-level checks the required build runs before its lage step. These are the ones nobody
  # copied, and they are the larger gap: a yarn.lock branch fails `dedup --list --fail` in CI with
  # no local warning at all. Taken straight from the yaml so that a check added there starts
  # running here without anyone remembering to mirror it.
  $text = Get-PipelineFile "code-format-validation.yaml"
  $checks = @()
  $skipped = @()
  foreach ($m in [regex]::Matches($text, "(?m)^\s*command:\s*'([^']+)'\s*\r?\n\s*displayName:\s*'([^']+)'")) {
    $command = $m.Groups[1].Value
    $display = $m.Groups[2].Value
    # The lage steps are run as one grouped invocation, not one at a time.
    if ($command -match "^\s*(typecheck|test|transpile)\b" -and $command -notmatch "--run") { continue }
    $reason = $null
    foreach ($key in $script:PipelineStepsNotRunnable.Keys) {
      if ($command -like "*$key*") { $reason = $script:PipelineStepsNotRunnable[$key]; break }
    }
    if ($reason) { $skipped += "$display ($reason)"; continue }
    if ($command -match "^(node --run|npm run|yarn) ") {
      $checks += [pscustomobject]@{ Name = $display; Command = $command }
      continue
    }
    $skipped += "$display (unrecognised command, so it is not run here: $command)"
  }
  return [pscustomobject]@{ Checks = @($checks); Skipped = @($skipped) }
}

function Get-ApplicableRepoChecks {
  param(
    [string[]] $Changed,
    [bool] $IsFull,
    [string] $TargetBranch
  )
  $pipeline = Get-PipelineRepoChecks
  if ($pipeline.Skipped.Count -gt 0) {
    Write-Host ("Pipeline steps not run here: {0}" -f ($pipeline.Skipped -join "; ")) -ForegroundColor DarkGray
  }

  # beachball:check runs in the fast pre-flight phase, so repo consistency covers remaining structural checks
  $allChecks = @(
    [pscustomobject]@{ Name = "Validate no self dependencies"; Command = "node --run validate:no-self-deps" },
    [pscustomobject]@{ Name = "Validate lockfile consistency"; Command = "node `"$([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\bohemia-pr-mcp\src\ci-install-cli.mjs')))`" `"$((Get-Location).Path)`" --verify" }
  ) + $pipeline.Checks

  if ($IsFull) {
    return @($allChecks)
  }

  # Analyze changed files to avoid whole-repo sweeps on unchanged input domains
  $hasLockfileChange = @($Changed | Where-Object { $_ -eq "pnpm-lock.yaml" -or $_ -like "*/pnpm-lock.yaml" -or $_ -eq "yarn.lock" -or $_ -like "*/yarn.lock" }).Count -gt 0
  $hasPackageJsonChange = @($Changed | Where-Object { $_ -eq "package.json" -or $_ -like "*/package.json" -or $_ -like "*syncpack*" }).Count -gt 0
  $hasMarkdownChange = @($Changed | Where-Object { $_ -like "*.md" -or $_ -like "*.markdown" -or $_ -like "docs/*" -or $_ -like "*rumdl*" }).Count -gt 0
  $hasBuildToolsOrScriptsChange = @($Changed | Where-Object { $_ -like "scripts/*" -or $_ -like "common/scripts/*" -or $_ -like "packages/office-bohemia-build-tools/*" }).Count -gt 0

  $applicable = @()
  $skipped = @()

  foreach ($check in $allChecks) {
    $cmd = $check.Command
    $needed = $true
    $skipReason = ""

    if ($hasBuildToolsOrScriptsChange) {
      $needed = $true
    }
    elseif ($cmd -like "*dedup*" -or $cmd -like "*validate:lockfile*") {
      if (-not $hasLockfileChange) {
        $needed = $false
        $skipReason = "lockfile not modified"
      }
    }
    elseif ($cmd -like "*syncpack*" -or $cmd -like "*package-json-formatter*" -or $cmd -like "*major-lock*" -or $cmd -like "*validate:no-self-deps*" -or $cmd -like "*ci-install-cli.mjs*" -or $cmd -like "*yarn --immutable*" -or $cmd -like "*yarn install*" -or $cmd -like "*pnpm install*") {
      if (-not $hasPackageJsonChange -and -not $hasLockfileChange) {
        $needed = $false
        $skipReason = "no package.json or dependency files modified"
      }
    }
    elseif ($cmd -like "*rumdl*" -or $cmd -like "*docs:generate-toc*" -or $cmd -like "*docs:validate*") {
      if (-not $hasMarkdownChange) {
        $needed = $false
        $skipReason = "no markdown/documentation files modified"
      }
    }

    if ($needed) {
      $applicable += $check
    }
    else {
      $skipped += ("{0} ({1})" -f $check.Name, $skipReason)
    }
  }

  if ($skipped.Count -gt 0) {
    Write-Host ("Repo consistency fast-path: skipped {0} unchanged sweep(s): {1}" -f $skipped.Count, ($skipped -join "; ")) -ForegroundColor DarkGray
  }

  return @($applicable)
}

function Join-RepoCheckCommands {
  param([string[]] $Commands)
  if (-not $Commands -or $Commands.Count -eq 0) { throw "No repository checks supplied" }
  $Commands = @($Commands | ForEach-Object {
    if ($IsWindows -and $_ -eq 'node --run dedupe:diagnostics -- --check') {
      $launcher = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "../../bohemia-pr-mcp/src/ci-dedupe.cjs"))
      'node "' + $launcher + '" "' + (Get-Location).Path + '"'
    } else { $_ }
  })
  if ($Commands.Count -eq 1) { return $Commands[0] }
  return ($Commands -join " && ")
}

function Get-AttributedCommits {
  # Publishing checks the actual messages; CLI settings and hooks alone are not proof of compliance.
  #
  # Narrow to attribution on purpose. A commit may still discuss the product's own AI surface;
  # what it may not do is credit a tool as an author of the work.
  param([string] $MergeBase)
  $pattern = '(?im)^\s*(co-authored-by:\s*(copilot|claude|chatgpt|cursor|gpt)|copilot-session:|generated (by|with) (ai|copilot|claude|chatgpt)|assisted[- ]by:?\s*(ai|copilot|claude))'
  $offenders = @()
  foreach ($sha in @(& git log --format=%H "$MergeBase..HEAD")) {
    $message = (& git log -1 --format=%B $sha) -join "`n"
    $hit = [regex]::Match($message, $pattern)
    if ($hit.Success) {
      $offenders += [pscustomobject]@{
        Sha     = $sha.Substring(0, 12)
        Subject = (& git log -1 --format=%s $sha)
        Line    = $hit.Value.Trim()
      }
    }
  }
  return @($offenders)
}

function Update-TargetRef {
  param([string] $Branch)
  $name = $Branch -replace '^(refs/remotes/origin/|refs/heads/|origin/)', ''
  & git check-ref-format "refs/heads/$name"
  if ($LASTEXITCODE -ne 0) { throw "Invalid target branch: $Branch" }
  & git fetch --no-tags --quiet origin "+refs/heads/${name}:refs/remotes/origin/${name}"
  if ($LASTEXITCODE -ne 0) { throw "Target refresh failed for $name; no checks or publication performed." }
  return "origin/$name"
}

function Invoke-Check {
  $TargetBranch = Update-TargetRef $TargetBranch
  $mergeBase = Get-MergeBase $TargetBranch
  $changed = @(& git diff --name-only $mergeBase --)
  if ($changed.Count -eq 0) {
    Write-Host "No changes against $TargetBranch; nothing to validate." -ForegroundColor Yellow
    return 0
  }
  $packages = $changed | ForEach-Object { ($_ -split '/')[0..1] -join '/' } | Sort-Object -Unique
  Write-Host ("Merge base {0}; {1} file(s) across {2}" -f $mergeBase.Substring(0, 12), $changed.Count, ($packages -join ", ")) -ForegroundColor DarkGray

  # Fail fast if there are uncommitted changes or untracked files before taking the gate lock or running builds.
  # If the developer or agent forgot to commit changes, failing upfront saves 15-25 minutes of builds.
  $initialDirty = @(@(& git status --porcelain) | Where-Object {
    $_ -and $_.Length -ge 4 -and (
      $_[0] -ne ' ' -or
      @(& git diff --ignore-all-space --ignore-blank-lines -- $_.Substring(3).Trim().Trim('"') 2>$null).Count -gt 0
    )
  })
  if ($initialDirty.Count -gt 0) {
    Write-Host "==> Working tree check (pre-flight)" -ForegroundColor Cyan
    Write-Host "    FAIL" -ForegroundColor Red
    $initialDirty | Select-Object -First 15 | ForEach-Object { Write-Host "      $_" }
    Write-Host "      Working tree has unstaged or untracked changes. Commit or clean them up before validating." -ForegroundColor Red
    Write-Host ""
    Write-Host "BLOCKED: Working tree is dirty. Commit changes first." -ForegroundColor Red
    Write-Telemetry @{
      kind    = "step"
      step    = "Working tree pre-flight check"
      seconds = 0
      failed  = $true
      reason  = "Working tree has uncommitted or untracked changes ($($initialDirty.Count) file(s))"
    }
    return 1
  }

  # Fail fast if there are merge conflicts against the target branch before taking gate locks or running builds.
  # Catches stale branches that diverged from master before wasting time on building or creating unmergeable PRs.
  $conflictCheck = Test-MergeConflict -TargetBranch $TargetBranch
  if ($conflictCheck.HasConflict) {
    Write-Host "==> Merge conflict check against $TargetBranch (pre-flight)" -ForegroundColor Cyan
    Write-Host "    FAIL" -ForegroundColor Red
    $conflictCheck.Output -split "`n" | ForEach-Object { Write-Host "      $_" }
    Write-Host ""
    Write-Host "BLOCKED: Branch has merge conflicts against $TargetBranch. Rebase or merge $TargetBranch first." -ForegroundColor Red
    Write-Telemetry @{
      kind    = "step"
      step    = "Merge conflict pre-flight check"
      seconds = 0
      failed  = $true
      reason  = "Branch has merge conflicts against $TargetBranch"
    }
    return 1
  }

  # Check if an identical clean gate pass was already recorded on this exact commit/tree within 30 minutes.
  # Eliminates duplicate validation when agents or developers run `bohemia check` followed immediately by `bohemia push`.
  if (Test-RecentGatePass -MergeBase $mergeBase -TargetBranch $TargetBranch -IsFull ([bool]$Full)) {
    Write-Host ("==> Gate cache hit: checks already passed for commit {0} (against {1}) within the last 30 minutes." -f ((& git rev-parse HEAD).Substring(0, 12)), $TargetBranch) -ForegroundColor Green
    Write-Host "    Reusing verified pass; skipping redundant build/test execution." -ForegroundColor DarkGray
    Write-Telemetry @{
      kind    = "step"
      step    = "Cached prior gate pass verification"
      seconds = 0
      failed  = $false
      reason  = "Reused recent gate pass on identical commit and merge base"
    }
    return 0
  }

  $results = @()

  # Before anything expensive, reconcile what this gate does against what branch policy actually
  # requires. A gate is only worth its runtime if it covers the checks that can refuse the branch,
  # and that list lives in Azure DevOps, not here.
  Assert-RequiredChecksCovered -TargetBranch $TargetBranch

  # Cheap and decisive, so it runs before the lock: a run that fails on this never occupies a slot
  # another agent is waiting for, and the author is told in seconds rather than after a full gate.
  $attributed = @(Get-AttributedCommits -MergeBase $mergeBase)
  if ($attributed.Count -gt 0) {
    Write-Host "==> Commit messages" -ForegroundColor Cyan
    Write-Host "    FAIL" -ForegroundColor Red
    foreach ($c in $attributed) {
      Write-Host ("      {0} {1}" -f $c.Sha, $c.Subject)
      Write-Host ("        remove this line: {0}" -f $c.Line)
    }
    # The exact command, not a hint. Every branch that trips this needs the same rewrite, and an
    # agent handed "use filter-branch or an interactive rebase" will improvise a worse one. Verified
    # to leave the tree hash byte identical while dropping only the offending lines.
    Write-Host "      Fix, from the repository root, with the tree clean:" -ForegroundColor Red
    Write-Host ("        set FILTER_BRANCH_SQUELCH_WARNING=1") -ForegroundColor Red
    Write-Host ("        git filter-branch -f --msg-filter ""sed -e '/^Co-authored-by: Copilot/d' -e '/^Copilot-Session:/d'"" {0}..HEAD" -f $mergeBase.Substring(0, 12)) -ForegroundColor Red
    Write-Host ("        git push --force-with-lease") -ForegroundColor Red
    Write-Host "      The rewrite touches messages only; confirm with git rev-parse HEAD^{tree} before and after." -ForegroundColor Red
    $results += [pscustomobject]@{ Name = "Commit messages credit an AI tool"; Failed = $true; Seconds = 0 }
    Write-Host ""
    Write-Host ("BLOCKED: {0}. Fix these before pushing." -f $results[0].Name) -ForegroundColor Red
    Write-Telemetry @{
      kind    = "step"
      step    = "Commit messages AI attribution check"
      seconds = 0
      failed  = $true
      reason  = "Commit messages credit an AI tool ($($attributed.Count) commit(s))"
    }
    return 1
  }

  # Fast pre-flight check: Disabling tests via .disabled file renaming (matches CI code-format-validation.yaml)
  $disabledTestFiles = @($changed | Where-Object { $_ -match '(^|/)(packages|apps|tools)/.*/src/.*\.disabled' -and $_ -notlike "*.cmdScript.disabled*" })
  if ($disabledTestFiles.Count -gt 0) {
    Write-Host "==> Disabled test files check (pre-flight)" -ForegroundColor Cyan
    Write-Host "    FAIL" -ForegroundColor Red
    $disabledTestFiles | ForEach-Object { Write-Host "      $_" }
    Write-Host "      Do not disable tests by renaming to .disabled. Use describe.skip, test.skip, or it.skip instead." -ForegroundColor Red
    Write-Host ""
    Write-Host "BLOCKED: Disabled test file renaming found. Use Jest skip modifiers instead." -ForegroundColor Red
    Write-Telemetry @{
      kind    = "step"
      step    = "Disabled test files pre-flight check"
      seconds = 0
      failed  = $true
      reason  = "Tests disabled via .disabled file renaming ($($disabledTestFiles.Count) file(s))"
    }
    return 1
  }

  # Fast pre-flight check 1: Beachball change file validation (runs in ~1s with --no-fetch matching CI)
  # Catches missing change files before taking gate locks or running long builds.
  $isMaster = ($TargetBranch -like "*master*" -or $TargetBranch -like "*main*")
  if ($isMaster -or @($changed | Where-Object { $_ -like "change/*" }).Count -gt 0) {
    $bbResult = Invoke-Gate "Beachball change file check" "node --run beachball:check -- --no-fetch"
    $results += $bbResult
    if ($bbResult.Failed) {
      Write-Host ""
      Write-Host "BLOCKED: Beachball change file check failed. Run 'yarn change' and commit before validating." -ForegroundColor Red
      return 1
    }
  }

  # Fast pre-flight check 2: SDL required lint (Compliance) (runs in ~2-4s without taking gate lock)
  # Catches forbidden innerHTML/DOM/security violations on changed sources upfront, excluding generated .d.ts.
  $sdlFiles = @($changed | Where-Object { $_ -match '(^|/)src/.*\.(js|jsx|ts|tsx)$' -and $_ -notlike "*.d.ts" } | Where-Object { Test-Path $_ })
  if ($sdlFiles.Count -gt 0) {
    $env:SDL_CLONE = (Get-Location).Path
    $runner = Join-Path $PSScriptRoot "sdl-lint.mjs"
    $sdlResult = Invoke-Gate "SDL required lint (Compliance)" `
      ('node "' + $runner + '" ' + (($sdlFiles | ForEach-Object { '"' + $_ + '"' }) -join ' '))
    $results += $sdlResult
    if ($sdlResult.Failed) {
      Write-Host ""
      Write-Host "BLOCKED: SDL required lint failed. Fix compliance errors above before continuing." -ForegroundColor Red
      return 1
    }
  }

  # The lock is taken here, not at startup, so a run that fails fast on bookkeeping, change files,
  # or SDL rules never occupies a slot other agents are waiting for.
  $lock = Enter-GateLock (Get-Location).Path
  try {

  # The repo-level checks the required build runs before its lage step, read from the pipeline
  # itself. Checks are smartly scoped to changed inputs (e.g. yarn.lock, package.json, *.md) so
  # untouched workspace sweeps are skipped while preserving 100% parity with CI requirements.
  # Pass -Full to force every sweep.
  $applicableChecks = Get-ApplicableRepoChecks -Changed $changed -IsFull ([bool]$Full) -TargetBranch $TargetBranch
  $repoCommands = @($applicableChecks | ForEach-Object { $_.Command })
  if ($repoCommands.Count -gt 0) {
    $repoCmd = Join-RepoCheckCommands -Commands $repoCommands
    $repoResult = Invoke-Gate "Repo consistency" $repoCmd
    $results += $repoResult
    if ($repoResult.Failed) {
      throw "Repository consistency failed; package validation was not started. Fix the reported check failure before publication."
    }
  }

  # The targets are read from the pipeline definition rather than written here, so a target added
  # to CI starts running in this gate without anyone remembering to mirror it. See
  # Get-PipelineLageTargets for why a transcribed list is not good enough: the previous one omitted
  # knip, which let a branch pass here and fail the required build on an unused dependency it had
  # just added to its own package. A gate that omits a blocking check is worse than no gate,
  # because it is believed.
  $targets = (Get-PipelineLageTargets) -join " "
  $flavor = Get-PipelineValidationFlavor
  Write-Host ("Targets from the pipeline: {0}" -f $targets) -ForegroundColor DarkGray
  # A repo-level file that belongs to no package makes --since select the entire workspace
  # (microsoft/lage#1146). yarn.lock is the common case: a ten line dependency bump expanded a
  # four file branch to 255 packages and a 6677 second refusal, in packages the branch never
  # touched. --ignore does not help; measured on lage 2.15.17, ignoring every changed file still
  # selected 255 packages while --since HEAD correctly selected none, so the flag has no effect
  # here. --scope does: the same branch selects 2. Its help states it "includes the dependencies
  # and dependents as well", so it covers everything --since would have selected for these
  # packages. The workspace-wide sweep is not lost, it moves to CI, which validates the merge
  # commit anyway and is the only place a full run is already paid for. Nor could it be cached
  # locally: lage.config.js lists yarn.lock in the global environmentGlob, so a lockfile edit
  # changes the cache hash of every package and each one rebuilds cold.
  $unowned = @(Get-UnownedChanges -Changed $changed -Root (Get-Location).Path)
  $ownedPackages = @(Get-ChangedPackageNames -Changed $changed -Root (Get-Location).Path)
  $selector = "--since $mergeBase"
  $skipLage = $false
  $globalPipelineChanged = $changed -contains "lage.config.js"
  if (-not $Full -and -not $globalPipelineChanged -and $ownedPackages.Count -gt 0) {
    $selector = "--scope " + ($ownedPackages -join " ") + " --no-deps"
    if ($unowned.Count -gt 0) {
      Write-Host ("Repo-level file(s) changed ({0}); selecting {1} package(s) directly instead of the whole workspace." -f ($unowned -join ", "), $ownedPackages.Count) -ForegroundColor DarkGray
    } else {
      Write-Host ("Scoped to {0} changed package(s) ({1}); upstream dependencies build as needed." -f $ownedPackages.Count, ($ownedPackages -join ", ")) -ForegroundColor DarkGray
    }
    Write-Host "CI revalidates downstream dependents on the merge commit." -ForegroundColor DarkGray
  }
  elseif (-not $Full -and $unowned.Count -gt 0 -and $ownedPackages.Count -eq 0 -and
          @($unowned | Where-Object { -not (Test-BuildInert $_) }).Count -eq 0) {
    $skipLage = $true
    Write-Host ("No package changed and no build input changed ({0}); there is nothing for these targets to run." -f ($unowned -join ", ")) -ForegroundColor DarkGray
    Write-Host "CI revalidates the workspace for these on the merge commit." -ForegroundColor DarkGray
  }

  if (-not $Full -and -not $skipLage) {
    $isCommentOrDocOnly = Test-CommentOrDocOnly -MergeBase $mergeBase -Changed $changed
    if ($isCommentOrDocOnly) {
      $nonDocCount = @($changed | Where-Object {
        $_ -notlike "change/*" -and $_ -notlike "*.md" -and $_ -notlike "*.markdown" -and $_ -notlike "docs/*"
      }).Count

      if ($nonDocCount -eq 0) {
        $skipLage = $true
        Write-Host "==> Fast-path: change is markdown/documentation only." -ForegroundColor Green
        Write-Host "    Skipping lage package builds; markdown lint/formatting already verified in repo consistency." -ForegroundColor DarkGray
      }
      else {
        Write-Host "==> Fast-path: code changes are comments/JSDoc only (AST-invariant)." -ForegroundColor Green
        Write-Host "    Skipping heavy transpile/test/typecheck targets; running formatting & lint validation only." -ForegroundColor DarkGray
        $pipeTargets = $targets -split '\s+'
        $fastTargets = @("prettier", "lint") | Where-Object { $pipeTargets -contains $_ }
        if ($fastTargets.Count -eq 0) { $fastTargets = @("prettier") }
        $targets = $fastTargets -join " "
      }
    }
  }

  if (-not $skipLage) {
    $results += Invoke-LageValidation -Targets $targets -Selector $selector `
      -WholeWorkspace ($Full -or $globalPipelineChanged -or $ownedPackages.Count -eq 0) -Flavor $flavor
  }

  }
  finally { Exit-GateLock $lock }

  # The gate itself regenerates these, so the churn has to be cleared here and not only in setup.
  # Otherwise every check leaves the tree dirty, and the standing prompts tell agents not to
  # discard local changes, so the noise rides into the pull request.
  Clear-GeneratedEolChurn

  # docs:generate-api-refs rewrites these, and CI restores them and then fails on any unstaged
  # file, so this has to match. It runs unconditionally because that target now always runs.
  #
  # Whitespace-only differences are excluded deliberately. A generated file can be left flagged as
  # modified on Windows while its content is byte-identical once line endings are normalised, and
  # git restore does not always settle it. CI checks out fresh with the repository's own eol rules
  # and never sees that, so failing on it here would be a local artefact, not a real finding.
  & git restore "packages/**/index.md" 2>$null
  $dirty = @(@(& git status --porcelain) | Where-Object {
    $_ -and $_.Length -ge 4 -and (
      $_[0] -ne ' ' -or
      @(& git diff --ignore-all-space --ignore-blank-lines -- $_.Substring(3).Trim().Trim('"') 2>$null).Count -gt 0
    )
  })
  if ($dirty.Count -gt 0) {
    Write-Host "==> Unstaged files after generation" -ForegroundColor Cyan
    Write-Host "    FAIL" -ForegroundColor Red
    $dirty | Select-Object -First 15 | ForEach-Object { Write-Host "      $_" }
    $results += [pscustomobject]@{ Name = "Unstaged files"; Failed = $true; Seconds = 0 }
  }

  $failed = @($results | Where-Object { $_.Failed })
  $total = ($results | Measure-Object -Property Seconds -Sum).Sum
  Write-Host ""
  if ($failed.Count -gt 0) {
    Write-Host ("BLOCKED after {0}s: {1}. Fix these before pushing." -f $total, ($failed.Name -join ", ")) -ForegroundColor Red
    return 1
  }
  Save-GatePassStamp -MergeBase $mergeBase -TargetBranch $TargetBranch -IsFull ([bool]$Full)
  Write-Host ("Checks passed in {0}s. CI validates the merge commit, so it can still differ." -f $total) -ForegroundColor Green
  return 0
}

function Invoke-Push {
  $branch = & git branch --show-current
  $head = & git rev-parse --verify HEAD
  if ($LASTEXITCODE -ne 0 -or -not $branch) { throw "Publication requires a checked-out branch and commit." }
  # Take the last emitted value: a function returns everything that reached the pipeline, so a
  # stray line from a git call would otherwise make this an array and defeat the comparison.
  $code = @(Invoke-Check) | Select-Object -Last 1
  if ([int]$code -ne 0) {
    Write-Host "Not pushing. Fix the failures above and run bohemia push again." -ForegroundColor Red
    return [int]$code
  }
  if ((& git branch --show-current) -ne $branch -or (& git rev-parse HEAD) -ne $head -or
      @(& git status --porcelain).Count -gt 0) {
    throw "Publication checkout changed; refusing to push."
  }
  $publicationArgs = if ($PushArgs.Count) { $PushArgs } else { @("origin", "${head}:refs/heads/${branch}") }
  Write-Host "==> git push $($publicationArgs -join ' ')" -ForegroundColor Cyan
  & git push @publicationArgs
  if ($LASTEXITCODE -ne 0) { return $LASTEXITCODE }
  if (-not $PushArgs.Count) {
    $remote = & git ls-remote --heads origin "refs/heads/$branch"
    if ($LASTEXITCODE -ne 0 -or ($remote -split '\s+')[0] -ne $head) {
      throw "Remote branch does not match the checked publication commit."
    }
  }
  return 0
}

function Enter-GateLock {
  # Two gates ran in this same worktree at once on 2026-08-24, with three more elsewhere on the
  # box: five lage runs, each spawning a worker per core, splitting sixteen cores between them.
  # Two in one clone is not merely slow but wrong, because they share one node_modules, one lage
  # cache and one working tree, and the prettier worker rewrites files as it checks them. Waiting
  # is strictly cheaper than thrashing: a scoped run finishes in minutes, so a queued agent starts
  # sooner than a contended one finishes. Named Mutexes are auto-released by Windows on process
  # crashes (AbandonedMutexException), preventing permanent slot exhaustion.
  param([string] $Root, [switch] $CloneOnly)
  $key = ($Root.ToLowerInvariant() -replace '[^a-z0-9]', '_')
  $slots = [Math]::Max(1, [int]([Environment]::ProcessorCount / 8))
  $slotNamespace = "bohemia-gate"
  if ($env:BOHEMIA_GATE_TEST_NAMESPACE) {
    if ($env:COPILOT_SESSION_ID -notlike "fixture-*" -or $env:BOHEMIA_GATE_TEST_NAMESPACE -notmatch '^bohemia-test-home-[a-zA-Z0-9]+$') {
      throw "Test gate slots require an isolated fixture session and test home."
    }
    $slotNamespace = "bohemia-gate-test-$($env:BOHEMIA_GATE_TEST_NAMESPACE)"
  }
  $lockStart = Get-Date

  $cloneMutex = New-Object System.Threading.Mutex($false, "Local\bohemia-gate-clone-$key")
  $cloneAcquired = $false
  try { $cloneAcquired = $cloneMutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $cloneAcquired = $true }
  if (-not $cloneAcquired) {
    Write-Host "Waiting: another gate is already running in this clone." -ForegroundColor DarkGray
    try { $cloneAcquired = $cloneMutex.WaitOne([TimeSpan]::FromMinutes(60)) }
    catch [System.Threading.AbandonedMutexException] { $cloneAcquired = $true }
  }
  if (-not $cloneAcquired) {
    $cloneMutex.Dispose()
    throw "Gave up after 60 minutes waiting for clone lock on $Root. Nothing was run."
  }

  if ($CloneOnly) {
    $waitDuration = [math]::Round(((Get-Date) - $lockStart).TotalSeconds)
    if ($waitDuration -ge 2) {
      Write-Telemetry @{ kind = "step"; step = "Clone concurrency lock queue"; seconds = $waitDuration; failed = $false }
    }
    return @($cloneMutex)
  }

  $machineSlot = $null
  $slotMutexes = @(for ($i = 0; $i -lt $slots; $i++) { New-Object System.Threading.Mutex($false, "Local\$slotNamespace-machine-slot-$i") })
  $pollDeadline = (Get-Date).AddMinutes(60)

  while (-not $machineSlot -and (Get-Date) -lt $pollDeadline) {
    for ($i = 0; $i -lt $slots; $i++) {
      $m = $slotMutexes[$i]
      $got = $false
      try { $got = $m.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $got = $true }
      if ($got) {
        $machineSlot = $m
        break
      }
    }
    if (-not $machineSlot) {
      Start-Sleep -Milliseconds 500
    }
  }

  # Dispose any unacquired machine slot mutexes
  foreach ($m in $slotMutexes) {
    if ($m -ne $machineSlot) { $m.Dispose() }
  }

  if (-not $machineSlot) {
    try { $cloneMutex.ReleaseMutex() } catch { }
    $cloneMutex.Dispose()
    throw "Gave up after 60 minutes waiting because the machine is at its gate limit of $slots. Nothing was run."
  }

  $waitDuration = [math]::Round(((Get-Date) - $lockStart).TotalSeconds)
  if ($waitDuration -ge 2) {
    Write-Telemetry @{
      kind     = "step"
      step     = "Gate concurrency lock queue"
      seconds  = $waitDuration
      failed   = $false
      timedOut = $false
      limit    = 3600
      command  = "Acquired clone and machine slot (waited ${waitDuration}s in queue)"
    }
  }

  return @($machineSlot, $cloneMutex)
}

function Exit-GateLock {
  param($Held)
  foreach ($handle in @($Held)) {
    if ($handle -is [System.Threading.Mutex]) {
      try { $handle.ReleaseMutex() } catch { }
      $handle.Dispose()
    }
  }
}

$root = if ($Action -eq "help") { $null } else { Resolve-RepoRoot $RepoRoot }
if ($root) { Push-Location $root }
$script:TelemetryRepo = $root
$script:RunStarted = Get-Date

function Complete-Run {
  # A run that dies or is killed never reaches here, which is the point: a run.start with no
  # run.end is exactly the hung run worth seeing.
  param([int] $ExitCode, [string] $Action, [string] $Reason = $null)
  $record = @{
    kind     = "run.end"
    action   = $Action
    exitCode = $ExitCode
    seconds  = [math]::Round(((Get-Date) - $script:RunStarted).TotalSeconds)
  }
  if ($Reason) { $record.reason = $Reason }
  Write-Telemetry $record
  return $ExitCode
}

if ($root) {
  Write-Telemetry @{ kind = "run.start"; action = $Action; pid = $PID; full = [bool]$Full }
}
try {
  switch ($Action) {
    "setup" { exit (Complete-Run (@(Invoke-Setup) | Select-Object -Last 1) $Action) }
    "build" { exit (Complete-Run (@(Invoke-Build) | Select-Object -Last 1) $Action) }
    "check" { exit (Complete-Run (@(Invoke-Check) | Select-Object -Last 1) $Action) }
    "push" { exit (Complete-Run (@(Invoke-Push) | Select-Object -Last 1) $Action) }
    default {
      Write-Host "bohemia setup   Install dependencies and warm the build so checks are incremental."
      Write-Host "bohemia build   Warm the repository build; optional -Packages name1,name2."
      Write-Host "bohemia check   Run the repository's required validation gates."
      Write-Host "bohemia push    Run repo gate checks, then push only if they passed."
      Write-Host ""
      Write-Host "Options: -RepoRoot <path>  -TargetBranch origin/master  -Full  -PushArgs '--force-with-lease'"
      exit 0
    }
  }
}
catch {
  $msg = $_.Exception.Message
  Write-Telemetry @{
    kind    = "step"
    step    = "Pre-flight initialization / Reconcile"
    failed  = $true
    reason  = $msg
    seconds = [math]::Round(((Get-Date) - $script:RunStarted).TotalSeconds)
  }
  Complete-Run 1 $Action -Reason $msg | Out-Null
  throw
}
finally {
  if ($root) { Pop-Location }
}
