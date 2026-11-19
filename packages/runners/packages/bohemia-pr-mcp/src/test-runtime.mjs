import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { loadYaml } from "./ci-install.mjs";

export function testPackages(root, names) {
  if (!path.isAbsolute(root) || !names.length) throw new Error("Test runtime preparation requires a checkout and explicit packages");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const workspace = path.join(root, "pnpm-workspace.yaml");
  const patterns = fs.existsSync(workspace) ? loadYaml(root).parse(fs.readFileSync(workspace, "utf8")).packages
    : Array.isArray(manifest.workspaces) ? manifest.workspaces : manifest.workspaces?.packages;
  if (!Array.isArray(patterns)) throw new Error("Cannot discover repository workspace packages");
  const wanted = new Set(names), found = new Set(), plans = [];
  for (const relative of fs.globSync(patterns.filter(pattern => !pattern.startsWith("!")), { cwd: root })) {
    if (patterns.some(pattern => pattern.startsWith("!") && path.matchesGlob(relative.replaceAll("\\", "/"), pattern.slice(1)))) continue;
    const directory = path.join(root, relative), file = path.join(directory, "package.json");
    if (!fs.existsSync(file)) continue;
    const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!wanted.has(pkg.name)) continue;
    if (found.has(pkg.name)) throw new Error(`Duplicate workspace package: ${pkg.name}`);
    found.add(pkg.name);
    plans.push({ name: pkg.name, directory, script: pkg.scripts?.test, browserScript: pkg.scripts?.["test:e2e"] });
  }
  for (const name of wanted) if (!found.has(name)) throw new Error(`Workspace package not found: ${name}`);
  return plans;
}

export function testRuntimePlans(root, names) {
  const plans = [];
  for (const pkg of testPackages(root, names)) {
    const { directory } = pkg;
    const script = pkg.script;
    if (typeof script !== "string") continue;
    // Reuse the checkout's declared setup, never invent a dependency list or run the test suite.
    const suffix = " && just-scripts test";
    if (!script.endsWith(suffix)) continue;
    const command = script.slice(0, -suffix.length).trim();
    if (!command) throw new Error(`Empty test setup for ${pkg.name}`);
    const config = ["jest.config.js", "jest.config.cjs"].find(name => fs.existsSync(path.join(directory, name)));
    if (!config) throw new Error(`Cannot verify the test configuration after setup for ${pkg.name}`);
    plans.push({ name: pkg.name, directory, command, config });
  }
  return plans;
}

function inside(root, file) {
  const relative = path.relative(root, file);
  return relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function diagnosticTestPlans(root, names, files) {
  if (!Array.isArray(files) || !files.length) throw new Error("Diagnostics require explicit unit-test files");
  const realRoot = fs.realpathSync(root);
  const packages = testPackages(root, names).map(pkg => ({ ...pkg, directory: fs.realpathSync(pkg.directory), files: [] }));
  for (const file of files) {
    if (typeof file !== "string" || !/^[\w@.\\/ -]+$/.test(file) ||
        path.isAbsolute(file) || path.win32.isAbsolute(file) || !/\.test\.[jt]sx?$/.test(file))
      throw new Error("Diagnostic files must be literal repository-relative unit-test paths");
    const absolute = fs.realpathSync(path.resolve(root, file));
    const pkg = packages.find(candidate => inside(realRoot, candidate.directory) &&
      inside(path.join(candidate.directory, "src"), absolute));
    if (!pkg || !fs.statSync(absolute).isFile())
      throw new Error(`Diagnostic file is outside the selected workspace package: ${file}`);
    if (pkg.script !== "just-scripts test" && !pkg.script?.endsWith(" && just-scripts test"))
      throw new Error(`Unsupported repository test script for ${pkg.name}`);
    if (!["jest.config.js", "jest.config.cjs"].some(config => fs.existsSync(path.join(pkg.directory, config))))
      throw new Error(`Missing Jest configuration for ${pkg.name}`);
    if (!pkg.files.includes(absolute)) pkg.files.push(absolute);
  }
  return packages.filter(pkg => pkg.files.length);
}

export function readDiagnosticGroundTruth(groundTruth, run = spawnSync) {
  const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$settings = [System.Xml.XmlReaderSettings]::new()
$settings.DtdProcessing = [System.Xml.DtdProcessing]::Prohibit
$settings.XmlResolver = $null
$settings.MaxCharactersInDocument = 16777216
$reader = [System.Xml.XmlReader]::Create($env:BOHEMIA_DIAGNOSTIC_XML, $settings)
try {
  $document = [System.Xml.XmlDocument]::new()
  $document.Load($reader)
} finally { $reader.Dispose() }
$failures = @($document.SelectNodes('//failure | //error'))
$declared = @($document.SelectNodes('//*[@failures or @errors]') | Where-Object {
  [int]$_.GetAttribute('failures') -gt 0 -or [int]$_.GetAttribute('errors') -gt 0
})
@{tests=$document.SelectNodes('//testcase').Count;failed=$failures.Count;declaredFailed=$declared.Count;
  details=(@($failures | Select-Object -First 3 | ForEach-Object {
    $text=$_.InnerText; $text.Substring(0,[Math]::Min(4000,$text.Length))
  }) -join [Environment]::NewLine)} |
  ConvertTo-Json -Compress
`;
  const raw = run(process.platform === "win32" ? "pwsh.exe" : "pwsh",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { encoding: "utf8", windowsHide: true, timeout: 60000,
      env: { ...process.env, BOHEMIA_DIAGNOSTIC_XML: groundTruth } });
  if (raw.error || raw.status !== 0) throw new Error(`Cannot verify diagnostic ground truth: ${groundTruth}: ${raw.error?.message || raw.stderr}`);
  return JSON.parse(raw.stdout);
}

export function runDiagnosticTests(root, names, files, directory, run = spawnSync) {
  const plans = diagnosticTestPlans(root, names, files);
  const { getTestEnvironment, verifyTestRun } = createRequire(import.meta.url)(
    path.join(root, "common", "scripts", "ftgTestRun.js"));
  fs.mkdirSync(directory, { recursive: true });
  const packages = [];
  for (const plan of plans) {
    const runId = randomUUID(), resultsDirectory = path.join(directory, runId);
    fs.mkdirSync(resultsDirectory);
    const execution = { runId, taskKey: `${path.relative(root, plan.directory)}#test:diagnostic`,
      resultsDirectory, evidenceFile: path.join(resultsDirectory, "ftg-evidence.json") };
    const report = path.join(resultsDirectory, "jest.json");
    console.log(`Selected test diagnostics (not required checks): ${plan.name}`);
    const result = run("node", ["--run", "test", "--", "--runInBand", "--coverage", "--",
      "--runTestsByPath", ...plan.files, "--json", "--outputFile", report,
      "--coverageDirectory", path.join(resultsDirectory, "coverage")],
    { cwd: plan.directory, encoding: "utf8", windowsHide: true, stdio: "inherit",
      env: { ...process.env, ...getTestEnvironment(execution) } });
    if (result.error || result.status !== 0)
      throw new Error(`Diagnostic tests failed for ${plan.name}; report: ${report}: ${result.error?.message || result.stderr || `exit ${result.status}`}`);
    if (!fs.existsSync(report)) throw new Error(`Missing fresh diagnostic report for ${plan.name}: ${report}`);
    verifyTestRun(execution);
    const evidence = JSON.parse(fs.readFileSync(report, "utf8"));
    const actual = (evidence.testResults || []).map(test => fs.realpathSync(test.name));
    if (evidence.success !== true || !Number.isInteger(evidence.numPassedTests) || !(evidence.numPassedTests > 0) ||
        !Number.isInteger(evidence.numTotalTests) || evidence.numTotalTests < evidence.numPassedTests ||
        evidence.numFailedTests !== 0 || actual.length !== plan.files.length ||
        new Set(actual).size !== plan.files.length || actual.some(file => !plan.files.includes(file)))
      throw new Error(`Diagnostic report does not prove successful tests for exactly the selected files: ${report}`);
    const groundTruth = path.join(resultsDirectory, "junit-with-failures.xml");
    const original = readDiagnosticGroundTruth(groundTruth, run);
    if (original.tests !== evidence.numTotalTests || original.failed !== 0 || original.declaredFailed !== 0)
      throw new Error(`Diagnostic ground truth includes failed or missing tests: ${groundTruth}: ${original.details}`);
    packages.push({ name: plan.name, files: plan.files, report,
      groundTruth, passed: evidence.numPassedTests, total: evidence.numTotalTests });
  }
  return { diagnostic: true, requiredChecksSatisfied: false, directory, packages };
}

export function prepareTestRuntimes(root, names, run = spawnSync) {
  const plans = testRuntimePlans(root, names);
  for (const plan of plans) {
    console.log(`Preparing declared test runtime: ${plan.name}`);
    const options = { cwd: plan.directory, encoding: "utf8", windowsHide: true, maxBuffer: 4 * 1024 * 1024 };
    const windows = process.platform === "win32";
    const setup = run(windows ? process.env.ComSpec || "cmd.exe" : "/bin/sh",
      windows ? ["/d", "/s", "/c", plan.command] : ["-c", plan.command], { ...options, stdio: "inherit" });
    if (setup.error || setup.status !== 0)
      throw new Error(`Test runtime setup failed for ${plan.name}: ${setup.error?.message || setup.stderr || `exit ${setup.status}`}`);
    const check = run("node", ["-e", "require(require('node:path').resolve(process.argv[1]))", plan.config], options);
    if (check.error || check.status !== 0)
      throw new Error(`Test configuration remains unavailable for ${plan.name}: ${check.error?.message || check.stderr || `exit ${check.status}`}`);
  }
  return plans.map(plan => plan.name);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = path.resolve(process.argv[2]), names = (process.argv[3] || "").split(",").filter(Boolean);
  if (["--diagnostic-tests", "--diagnostic-plan"].includes(process.argv[4])) {
    const files = JSON.parse(Buffer.from(process.argv[5], "base64").toString("utf8"));
    if (process.argv[4] === "--diagnostic-plan") diagnosticTestPlans(root, names, files);
    else {
      const result = runDiagnosticTests(root, names, files, process.argv[6]);
      fs.writeFileSync(path.join(process.argv[6], "result.json"), JSON.stringify(result), { flag: "wx" });
    }
  } else prepareTestRuntimes(root, names);
}
