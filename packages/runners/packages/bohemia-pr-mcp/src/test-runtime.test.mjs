import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { testRuntimePlans, prepareTestRuntimes } from "./test-runtime.mjs";

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
