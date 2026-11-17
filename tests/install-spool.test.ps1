$ErrorActionPreference = "Stop"
$installer = Join-Path $PSScriptRoot "..\install-spool.ps1"
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ("..\.runner\spool-install-test-" + [guid]::NewGuid())))
New-Item -ItemType Directory -Path (Join-Path $root "target\release") -Force | Out-Null
New-Item -ItemType File -Path (Join-Path $root "target\release\spool.exe") | Out-Null

$global:spoolInstallerTestState = @{}
function Get-ScheduledTask { param($TaskName, $ErrorAction) $global:spoolInstallerTestState.Existing }
function New-ScheduledTaskAction {
    param($Execute, $WorkingDirectory, $Argument)
    @{ Execute = $Execute; WorkingDirectory = $WorkingDirectory; Arguments = $Argument }
}
function Set-ScheduledTask {
    param($TaskName, $Action, $Settings)
    $global:spoolInstallerTestState.Updated = $Action
    $global:spoolInstallerTestState.Settings = $Settings
    $global:spoolInstallerTestState.Updates++
}
function Start-ScheduledTask { param($TaskName) $global:spoolInstallerTestState.Starts++ }
function Enable-ScheduledTask { param($TaskName) $global:spoolInstallerTestState.Enabled = $true }
function Register-ScheduledTask { throw "Existing tasks must retain their principal, triggers and settings." }
function Assert($Condition, $Message) { if (!$Condition) { throw $Message } }

try {
    foreach ($state in @("Running", "Ready")) {
        $global:spoolInstallerTestState = @{ Existing = @{ State = $state; Settings = @{ Priority = 7; OtherSetting = 'preserved' } }; Updates = 0; Starts = 0 }
        & $installer -TaskName "Fixture" -Root $root | Out-Null
        Assert ($global:spoolInstallerTestState.Updates -eq 1) "The existing action was not repaired."
        Assert ($global:spoolInstallerTestState.Starts -eq [int]($state -eq "Ready")) "Running task was restarted."
        $updated = $global:spoolInstallerTestState.Updated
        Assert ($updated.Execute -like '*run-hidden-*.exe') "Launcher is not windowless."
        Assert ($updated.Arguments -like "*-NonInteractive*") "Launcher is interactive."
        Assert $global:spoolInstallerTestState.Enabled "Existing disabled tasks must be enabled."
        Assert ($updated.Arguments.Contains('-Root "' + $root + '"')) "Root was not preserved."
        Assert ($updated.WorkingDirectory -eq $root) "Working directory changed."
        Assert ($global:spoolInstallerTestState.Settings.Priority -eq 4) "Task priority was not updated."
        Assert ($global:spoolInstallerTestState.Settings.OtherSetting -eq 'preserved') "Existing settings were discarded."
    }
    Write-Output "PASS: running and stopped task updates preserve settings and active sessions."
} finally {
    Remove-Item -LiteralPath $root -Recurse -Force
    Remove-Variable spoolInstallerTestState -Scope Global
}
