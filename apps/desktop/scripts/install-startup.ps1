param([Parameter(Mandatory)][string]$AppPath)
$ErrorActionPreference = 'Stop'
$app = (Resolve-Path -LiteralPath $AppPath).Path
if ([IO.Path]::GetExtension($app) -ne '.exe') { throw 'AppPath must be the installed Spool executable.' }
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute $app -WorkingDirectory (Split-Path $app)
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -Priority 4
Register-ScheduledTask -TaskName 'Spool Desktop' -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings -Description 'Start the installed Spool desktop app at sign-in.' -Force | Out-Null
$registered = Get-ScheduledTask -TaskName 'Spool Desktop'
if ($registered.Actions.Execute -ne $app -or $registered.Principal.LogonType -ne 'Interactive') {
    throw 'Desktop login task verification failed; existing web startup was preserved.'
}
$legacy = Get-ScheduledTask -TaskName 'Spool Web UI' -ErrorAction SilentlyContinue
if ($legacy) {
    Disable-ScheduledTask -TaskName 'Spool Web UI' | Out-Null
    Stop-ScheduledTask -TaskName 'Spool Web UI'
}
Start-ScheduledTask -TaskName 'Spool Desktop'
Write-Output 'Spool Desktop starts at sign-in. The daemon and runner tasks were not changed.'
