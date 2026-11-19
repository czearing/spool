$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'hidden-task.ps1')
$launcher = Get-HiddenTaskLauncher
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ("..\.runner\spool-hidden-test-" + [guid]::NewGuid())))
New-Item -ItemType Directory -Path $root | Out-Null
try {
    $script = Join-Path $root 'child with spaces.ps1'
    @'
param([string]$Value)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
if ($Value -eq 'hold') {
    $child = Start-Process -FilePath (Join-Path $PSHOME 'pwsh.exe') -ArgumentList '-NoProfile -NonInteractive -Command "Start-Sleep -Seconds 120"' -NoNewWindow -PassThru
    @{ parent = $PID; child = $child.Id } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $pwd 'processes.json')
    $child.WaitForExit()
    exit 0
}
Add-Type 'using System; using System.Runtime.InteropServices; public class ConsoleProbe { [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow(); }'
@{ console = [ConsoleProbe]::GetConsoleWindow().ToInt64(); value = $Value; cwd = "$pwd" } |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $pwd 'result.json')
Write-Output 'child stdout'
[Console]::Error.WriteLine('child stderr')
exit 23
'@ | Set-Content -LiteralPath $script
    $info = [Diagnostics.ProcessStartInfo]::new($launcher)
    $info.UseShellExecute = $false
    $value = 'spaces, "quoted text", and trailing slash\'
    foreach ($argument in @((Join-Path $root 'test.log'), $root, (Get-Command pwsh.exe).Source,
        '-NoProfile', '-NonInteractive', '-File', $script, '-Value', $value)) { $info.ArgumentList.Add($argument) }
    $process = [Diagnostics.Process]::Start($info)
    if (!$process.WaitForExit(15000)) { Stop-Process -Id $process.Id; throw 'Hidden launcher did not finish.' }
    if ($process.ExitCode -ne 23) { throw "Child exit status was lost: $($process.ExitCode)" }
    $result = Get-Content -LiteralPath (Join-Path $root 'result.json') -Raw | ConvertFrom-Json
    if ($result.console -ne 0) { throw 'Child has a console window.' }
    if ($result.value -cne $value -or $result.cwd -ne $root) { throw 'Arguments or working directory changed.' }
    $log = Get-Content -LiteralPath (Join-Path $root 'test.log') -Raw
    if ($log -notmatch 'child stdout' -or $log -notmatch 'child stderr' -or $log -notmatch 'Exited 23') {
        throw 'Child output or lifecycle evidence was lost.'
    }
    $info.ArgumentList[2] = Join-Path $root 'missing.exe'
    $process = [Diagnostics.Process]::Start($info)
    if (!$process.WaitForExit(15000)) { Stop-Process -Id $process.Id; throw 'Failed launch did not exit.' }
    if ($process.ExitCode -ne 1 -or (Get-Content (Join-Path $root 'test.log') -Raw) -notmatch 'Startup failed') {
        throw 'Launch errors must fail visibly in the log.'
    }
    $info.ArgumentList[2] = (Get-Command pwsh.exe).Source
    $info.ArgumentList[$info.ArgumentList.Count - 1] = 'hold'
    $process = [Diagnostics.Process]::Start($info)
    $deadline = (Get-Date).AddSeconds(15)
    while (!(Test-Path (Join-Path $root 'processes.json')) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 100 }
    try {
        $children = Get-Content (Join-Path $root 'processes.json') -Raw | ConvertFrom-Json
        Stop-Process -Id $process.Id
        $deadline = (Get-Date).AddSeconds(5)
        do {
            Start-Sleep -Milliseconds 100
            $remaining = @(Get-Process -Id $children.parent,$children.child -ErrorAction SilentlyContinue)
        } while ($remaining.Count -and (Get-Date) -lt $deadline)
        if ($remaining.Count) { throw 'Stopping the launcher orphaned its child processes.' }
    } finally { if (!$process.HasExited) { Stop-Process -Id $process.Id } }
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes(@'
Add-Type 'using System; using System.Runtime.InteropServices; public class EncodedConsoleProbe { [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow(); }'
@{ console = [EncodedConsoleProbe]::GetConsoleWindow().ToInt64(); cwd = "$pwd" } |
    ConvertTo-Json | Set-Content -LiteralPath 'encoded-result.json'
Write-Output 'encoded child stdout'
exit 31
'@))
    $action = New-HiddenCommandTaskAction -Root $root -Executable (Get-Command powershell.exe).Source `
        -Arguments "-NoProfile -NonInteractive -EncodedCommand $encoded" -Log (Join-Path $root 'encoded.log')
    $encodedInfo = [Diagnostics.ProcessStartInfo]::new($action.Execute)
    $encodedInfo.UseShellExecute = $false
    $encodedInfo.Arguments = $action.Arguments
    $encodedProcess = [Diagnostics.Process]::Start($encodedInfo)
    if (!$encodedProcess.WaitForExit(15000)) {
        Stop-Process -Id $encodedProcess.Id
        throw 'Encoded hidden command did not finish.'
    }
    $encodedResult = Get-Content -LiteralPath (Join-Path $root 'encoded-result.json') -Raw | ConvertFrom-Json
    if ($encodedProcess.ExitCode -ne 31 -or $encodedResult.console -ne 0 -or $encodedResult.cwd -ne $root) {
        throw 'Encoded scheduled-task commands must preserve exit status and working directory without a console.'
    }
    $encodedLog = Get-Content -LiteralPath (Join-Path $root 'encoded.log') -Raw
    if ($encodedLog -notmatch 'encoded child stdout' -or $encodedLog -notmatch 'Exited 31') {
        throw 'Encoded command output or lifecycle evidence was lost.'
    }
    Write-Output 'PASS: no console, arguments, encoded task commands, logs, exit status, launch errors and full child-tree cleanup.'
} finally { Remove-Item -LiteralPath $root -Recurse -Force }
