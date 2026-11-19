param([string]$TaskName = "Spool Daemon", [string]$Root = $PSScriptRoot)
$ErrorActionPreference = "Stop"
$Root = (Resolve-Path -LiteralPath $Root).Path
$binary = Join-Path $Root "target\release\spool.exe"
if (!(Test-Path -LiteralPath $binary -PathType Leaf)) { throw "Build Spool with cargo build --release before installation." }
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
. (Join-Path $PSScriptRoot 'scripts\hidden-task.ps1')
$action = New-HiddenTaskAction -Root $Root -Script (Join-Path $Root 'start-spool.ps1') `
    -Arguments ('-Root "{0}"' -f $Root) -Log (Join-Path $Root '.runner\daemon-startup.log')
if ($existing) {
    $existing.Settings.Priority = 4
    Set-ScheduledTask -TaskName $TaskName -Action $action -Settings $existing.Settings | Out-Null
    Enable-ScheduledTask -TaskName $TaskName | Out-Null
    if ($existing.State -eq "Running") {
        Write-Output "$TaskName startup updated; existing agent sessions are preserved."
        return
    }
    Start-ScheduledTask -TaskName $TaskName
    Get-ScheduledTask -TaskName $TaskName
    return
}
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -Priority 4
Register-ScheduledTask -TaskName $TaskName -Action $action `
    -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $user) `
    -Principal (New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited) `
    -Settings $settings -Description "Spool daemon; executable-owned singleton and original agent sessions." -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Get-ScheduledTask -TaskName $TaskName
