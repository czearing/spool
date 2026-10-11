import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { copyFileSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fixture } from "./fixtures.mjs";

test("updating the web release preserves boot credentials, triggers and running processes", {
  skip: process.platform !== "win32",
}, t => {
  const f = fixture(t), ui = path.join(f.root, "ui"), spool = path.join(f.root, "spool");
  for (const directory of ["scripts", ".next/release", "node_modules/next/dist/bin"]) {
    mkdirSync(path.join(ui, directory), { recursive: true });
  }
  mkdirSync(path.join(spool, "scripts"), { recursive: true });
  writeFileSync(path.join(ui, ".next/release/BUILD_ID"), "test");
  writeFileSync(path.join(ui, "node_modules/next/dist/bin/next"), "");
  const installer = path.join(ui, "scripts/install-startup.ps1");
  copyFileSync(path.resolve(import.meta.dirname, "../../../spool-web-ui/scripts/install-startup.ps1"), installer);
  writeFileSync(path.join(spool, "scripts/hidden-task.ps1"), "function New-HiddenTaskAction { 'fixture-action' }");
  const script = path.join(f.root, "verify.ps1");
  writeFileSync(script, `
$ErrorActionPreference = 'Stop'
$global:updated = $false
function Get-ScheduledTask { [pscustomobject]@{ State = 'Running'; Principal = @{ LogonType = 'Password' } } }
function Export-ScheduledTask { '<Task><Triggers><BootTrigger /></Triggers></Task>' }
function New-ScheduledTaskSettingsSet {
  param($RestartCount, $RestartInterval, $MultipleInstances, $ExecutionTimeLimit, $Priority,
    [switch]$StartWhenAvailable, [switch]$AllowStartIfOnBatteries, [switch]$DontStopIfGoingOnBatteries)
  if ($Priority -ne 4 -or $RestartCount -ne 999) { throw 'Startup priority/recovery settings missing' }
  @{ Priority = $Priority }
}
function Set-ScheduledTask {
  param($TaskName, $Action, $Settings, $Trigger, $Principal)
  if ($PSBoundParameters.ContainsKey('Trigger') -or $PSBoundParameters.ContainsKey('Principal')) {
    throw 'Existing boot mode must not be replaced'
  }
  if ($Action -ne 'fixture-action' -or $Settings.Priority -ne 4) { throw 'Update missing' }
  $global:updated = $true
}
function Register-ScheduledTask { throw 'Existing boot credentials must not be re-registered' }
function Enable-ScheduledTask {}
function Start-ScheduledTask { throw 'Running server must not be interrupted' }
& '${installer.replaceAll("'", "''")}' -DistDir '.next\\release' -SpoolRoot '${spool.replaceAll("'", "''")}'
if (!$global:updated) { throw 'Existing startup action was not updated' }
`);
  const result = spawnSync("pwsh.exe", ["-NoProfile", "-NonInteractive", "-File", script], {
    encoding: "utf8", windowsHide: true, timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(readFileSync(path.join(ui, ".spool-ui/startup.json"), "utf8")).distDir, ".next\\release");
});
