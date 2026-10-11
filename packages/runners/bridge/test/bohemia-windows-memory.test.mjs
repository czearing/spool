import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("Windows validation uses Knip's normal parser and restores explicit environment on success and failure",
  { skip: process.platform !== "win32" }, () => {
    const script = fileURLToPath(new URL("../../packages/dedicated-runners/repo-gates/bohemia.ps1", import.meta.url));
    const command = `
$ErrorActionPreference = "Stop"
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile('${script.replaceAll("'", "''")}', [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
$definition = $ast.Find({ param($node)
  $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq "Invoke-LageValidation"
}, $true)
. ([scriptblock]::Create($definition.Extent.Text))
function Invoke-Gate {
  param($Name, $Command, $TimeoutSeconds)
  $script:Seen = $env:KNIP_DISABLE_RAW_TRANSFER
  if ($Command -ne "node --run lage -- knip test --coverage --grouped --scope fixture --allow-no-target-runs --flavor unit-test") {
    throw "Validation targets changed"
  }
  if ($TimeoutSeconds -ne 5400) { throw "Coverage needs the bounded full-workspace budget" }
  if ($script:Fail) { throw "fixture failure" }
}
$original = $env:KNIP_DISABLE_RAW_TRANSFER
try {
  foreach ($value in @($null, "0", "1")) {
    foreach ($fail in @($false, $true)) {
      $env:KNIP_DISABLE_RAW_TRANSFER = $value; $script:Fail = $fail
      $thrown = $false
      try { Invoke-LageValidation "knip test --coverage" "--scope fixture" $false "unit-test" }
      catch { $thrown = $true; if (-not $fail -or $_.Exception.Message -ne "fixture failure") { throw } }
      if ($thrown -ne $fail) { throw "Validation failures must propagate" }
      $expected = if ([string]::IsNullOrEmpty($value)) { "1" } else { $value }
      if ($script:Seen -ne $expected) { throw "Knip parser setting was not applied" }
      if ($env:KNIP_DISABLE_RAW_TRANSFER -ne $value) { throw "Environment was not restored" }
    }
  }
  function Invoke-Gate {
    param($Name, $Command, $TimeoutSeconds)
    if ($TimeoutSeconds -ne 1500) { throw "Noncoverage checks retain their existing deadline" }
  }
  Invoke-LageValidation "knip" "--scope fixture" $false "unit-test"
  Write-Output "passed"
}
finally { $env:KNIP_DISABLE_RAW_TRANSFER = $original }
`;
    assert.equal(execFileSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", command],
      { encoding: "utf8", windowsHide: true }).trim(), "passed");
  });
