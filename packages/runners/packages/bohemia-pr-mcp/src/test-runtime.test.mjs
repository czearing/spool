import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { testRuntimePlans, prepareTestRuntimes, diagnosticTestPlans, runDiagnosticTests } from "./test-runtime.mjs";

function fixture(t, script = "node prepare.cjs && just-scripts test") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bohemia test-runtime "));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pkg = path.join(root, "packages", "fixture");
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@fixture/runtime", scripts: { test: script } }));
  fs.writeFileSync(path.join(pkg, "prepare.cjs"), "require('node:fs').writeFileSync('runtime.json', '{}')");
  fs.writeFileSync(path.join(pkg, "jest.config.cjs"), "module.exports = require('./runtime.json')");
  return { root, pkg, names: ["@fixture/runtime"] };
}

test("runs the repository-owned setup, verifies config, and never invokes the test suite", t => {
  const f = fixture(t);
  assert.deepEqual(prepareTestRuntimes(f.root, f.names), f.names);
  assert.ok(fs.existsSync(path.join(f.pkg, "runtime.json")));
});

test("preserves the PR's isolated runtime setup exactly instead of substituting workspace React", t => {
  const prefix = "node test-runtimes/react19/prepareRuntime.cjs && pnpm --dir ../../.tmp/runtime install --ignore-workspace --frozen-lockfile --ignore-scripts --registry=https://example.invalid/";
  const f = fixture(t, `${prefix} && just-scripts test`);
  assert.equal(testRuntimePlans(f.root, f.names)[0].command, prefix);
  const calls = [];
  prepareTestRuntimes(f.root, f.names, (exe, args, options) => {
    calls.push({ exe, args, options });
    return { status: 0 };
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].args.at(-1), prefix);
  assert.equal(calls[0].options.cwd, f.pkg);
  assert.equal(calls[1].exe, "node");
  assert.equal(calls[1].args.at(-1), "jest.config.cjs");
});

test("failed setup and still-missing config dependencies both block readiness", t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.pkg, "prepare.cjs"), "process.exit(7)");
  assert.throws(() => prepareTestRuntimes(f.root, f.names), /setup failed.*exit 7/);
  fs.writeFileSync(path.join(f.pkg, "prepare.cjs"), "");
  assert.throws(() => prepareTestRuntimes(f.root, f.names), /configuration remains unavailable.*MODULE_NOT_FOUND/s);
});

test("ordinary test scripts are not executed, and missing scopes fail closed", t => {
  const f = fixture(t, "just-scripts test");
  assert.deepEqual(prepareTestRuntimes(f.root, f.names, () => { throw new Error("Must not execute tests"); }), []);
  assert.throws(() => testRuntimePlans(f.root, ["@fixture/missing"]), /package not found/);
  assert.throws(() => testRuntimePlans(f.root, []), /explicit packages/);
});

test("pnpm workspace discovery respects excluded directories", t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n  - '!packages/excluded'\n");
  const excluded = path.join(f.root, "packages", "excluded");
  fs.mkdirSync(excluded);
  fs.copyFileSync(path.join(f.pkg, "package.json"), path.join(excluded, "package.json"));
  assert.equal(testRuntimePlans(f.root, f.names).length, 1);
});

function diagnosticFixture(t) {
  const f = fixture(t, "just-scripts test");
  fs.mkdirSync(path.join(f.pkg, "src"));
  const file = path.join(f.pkg, "src", "example.test.ts");
  fs.writeFileSync(file, "test('example', () => {});");
  const scripts = path.join(f.root, "common", "scripts");
  fs.mkdirSync(scripts, { recursive: true });
  fs.writeFileSync(path.join(scripts, "ftgTestRun.js"), `
const fs = require('node:fs');
exports.getTestEnvironment = run => ({
  FTG_RUN_ID: run.runId, FTG_TASK_KEY: run.taskKey,
  FTG_RESULTS_DIRECTORY: run.resultsDirectory, FTG_EVIDENCE_FILE: run.evidenceFile
});
exports.verifyTestRun = run => {
  const evidence = JSON.parse(fs.readFileSync(run.evidenceFile));
  if(evidence.runId !== run.runId || evidence.taskKey !== run.taskKey ||
    !fs.existsSync(evidence.groundTruthPath) || !fs.existsSync(evidence.junitPath)) throw Error('Invalid original-result evidence');
};
`);
  return { ...f, file, files: [path.relative(f.root, file)], reports: path.join(f.root, ".git", "diagnostics") };
}

function diagnosticArtifacts(args, options, evidence) {
  const directory = options.env.FTG_RESULTS_DIRECTORY;
  for (const name of ["junit-with-failures.xml", "junit.xml"])
    fs.writeFileSync(path.join(directory, name), '<testsuites><testsuite><testcase name="example" /></testsuite></testsuites>');
  fs.writeFileSync(options.env.FTG_EVIDENCE_FILE, JSON.stringify({
    runId: options.env.FTG_RUN_ID, taskKey: options.env.FTG_TASK_KEY,
    groundTruthPath: path.join(directory, "junit-with-failures.xml"), junitPath: path.join(directory, "junit.xml")
  }));
  if (evidence) fs.writeFileSync(args[args.indexOf("--outputFile") + 1], JSON.stringify(evidence));
}

test("diagnostics require exact unit-test files in selected workspace packages, not flags, patterns or symlink escapes", t => {
  const f = diagnosticFixture(t);
  assert.deepEqual(diagnosticTestPlans(f.root, f.names, f.files).map(plan => plan.files), [[f.file]]);
  for (const files of [[], ["--passWithNoTests"], ["packages/*"], [f.file], ["../outside.test.ts"]]) {
    assert.throws(() => diagnosticTestPlans(f.root, f.names, files));
  }
  const outside = path.join(f.root, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "other.test.ts"), "");
  const alias = path.join(f.pkg, "src", "linked");
  fs.symlinkSync(outside, alias, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => diagnosticTestPlans(f.root, f.names,
    [path.relative(f.root, path.join(alias, "other.test.ts"))]), /selected workspace package/);
});

test("diagnostics use the declared test script and require fresh successful reports for exactly the selected files", t => {
  const f = diagnosticFixture(t);
  const calls = [];
  const result = runDiagnosticTests(f.root, f.names, f.files, f.reports, (exe, args, options) => {
    calls.push({ exe, args, options });
    if (exe === "node") {
      diagnosticArtifacts(args, options, {
        success: true, numTotalTests: 2, numPassedTests: 2, numFailedTests: 0,
        testResults: [{ name: f.file }]
      });
      return { status: 0 };
    }
    return { status: 0, stdout: JSON.stringify({ tests: 2, failed: 0, declaredFailed: 0 }) };
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].exe, "node");
  assert.equal(calls[0].options.cwd, f.pkg);
  assert.deepEqual(calls[0].args.slice(0, 7),
    ["--run", "test", "--", "--runInBand", "--coverage", "--", "--runTestsByPath"]);
  assert.equal(calls[0].args[7], f.file);
  assert.equal(result.requiredChecksSatisfied, false);
  assert.equal(result.diagnostic, true);
  assert.equal(result.packages[0].passed, 2);
  assert.ok(fs.existsSync(result.packages[0].report));
  assert.throws(() => runDiagnosticTests(f.root, f.names, f.files, f.reports, () => ({ status: 0 })),
    /Missing fresh diagnostic report/);
});

test("successful exits cannot hide missing, empty, failed, stale or incorrectly scoped diagnostic reports", t => {
  const f = diagnosticFixture(t);
  for (const report of [
    null,
    { success: true, numTotalTests: 0, numPassedTests: 0, numFailedTests: 0, testResults: [] },
    { success: false, numTotalTests: 1, numPassedTests: 0, numFailedTests: 1, testResults: [{ name: f.file }] },
    { success: true, numTotalTests: 1, numPassedTests: 1, numFailedTests: 0,
      testResults: [{ name: path.join(f.pkg, "src", "unselected.test.ts") }] }
  ]) {
    assert.throws(() => runDiagnosticTests(f.root, f.names, f.files, f.reports, (_exe, args, options) => {
      diagnosticArtifacts(args, options, report);
      return { status: 0 };
    }));
  }
  assert.throws(() => runDiagnosticTests(f.root, f.names, f.files, f.reports,
    () => ({ status: 7, stderr: "Expected completed state, received Check again" })),
  /Expected completed state, received Check again/);
});

test("the declared test command receives exact diagnostic paths and report flags through a real child process", t => {
  const f = diagnosticFixture(t);
  const bin = path.join(f.root, "node_modules", ".bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(f.pkg, "fake-jest.cjs"), `
const fs = require('node:fs');
const args = process.argv.slice(2);
const start = args.indexOf('--runTestsByPath') + 1;
const end = args.indexOf('--json');
if (args[0] !== 'test' || !args.includes('--runInBand') || !args.includes('--coverage') || start < 1 || end < start) process.exit(9);
const files = args.slice(start, end);
fs.writeFileSync(args[args.indexOf('--outputFile') + 1], JSON.stringify({
  success: true, numTotalTests: files.length, numPassedTests: files.length, numFailedTests: 0,
  testResults: files.map(name => ({ name }))
}));
const path = require('node:path');
const directory = process.env.FTG_RESULTS_DIRECTORY;
const failed = fs.existsSync('raw-failure');
const xml = failed ? '<testsuites><testsuite failures="1"><testcase name="example"><failure>Original failure was suppressed</failure></testcase></testsuite></testsuites>'
  : '<testsuites><testsuite><testcase name="example" /></testsuite></testsuites>';
for (const name of ['junit-with-failures.xml', 'junit.xml']) fs.writeFileSync(path.join(directory, name), xml);
fs.writeFileSync(process.env.FTG_EVIDENCE_FILE, JSON.stringify({
  runId: process.env.FTG_RUN_ID, taskKey: process.env.FTG_TASK_KEY,
  groundTruthPath: path.join(directory, 'junit-with-failures.xml'), junitPath: path.join(directory, 'junit.xml')
}));
`);
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(bin, "just-scripts.cmd"),
      '@echo off\r\nnode "%~dp0..\\..\\packages\\fixture\\fake-jest.cjs" %*\r\n');
  } else {
    fs.writeFileSync(path.join(bin, "just-scripts"),
      "#!/usr/bin/env node\nrequire('../../packages/fixture/fake-jest.cjs');\n", { mode: 0o755 });
  }
  const result = runDiagnosticTests(f.root, f.names, f.files, f.reports);
  assert.equal(result.packages[0].passed, 1);
  assert.deepEqual(result.packages[0].files, [f.file]);
  assert.ok(result.packages[0].groundTruth.startsWith(f.reports));
  fs.writeFileSync(path.join(f.pkg, "raw-failure"), "");
  assert.throws(() => runDiagnosticTests(f.root, f.names, f.files, f.reports),
    /Original failure was suppressed/);
});
