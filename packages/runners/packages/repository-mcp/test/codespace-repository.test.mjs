import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { codespaceRepositoryAdapter } from "../src/codespaces/repository.mjs";
import { execute } from "../src/process.mjs";
import { assertPreparationEvidence } from "../src/codespaces/review.mjs";
import { readBatchBlobs, reviewSourcePackageNames } from "../src/codespaces/metadata.mjs";

function fixture(t, options = {}) {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), "native-review-"));
  t.after(() => fs.rmSync(storage, { recursive: true, force: true }));
  const root = path.join(storage, "repo"), directory = "midgard/packages/review-target";
  fs.mkdirSync(path.join(root, directory, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, directory, "package.json"), JSON.stringify({
    name: "@1js/review-target", scripts: { build: "midgard-scripts build", lint: "midgard-scripts lint",
      typecheck: "midgard-scripts typecheck", test: "jest", ...(options.application ? { start: "midgard-scripts start" } : {}) },
  }));
  fs.writeFileSync(path.join(root, directory, "src", "index.ts"), "export const value = 1;\n");
  fs.writeFileSync(path.join(root, "midgard", "package.json"), JSON.stringify({ name: "midgard" }));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe", encoding: "utf8" }).trim();
  git("init", "--quiet");
  git("add", ".");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "Fixture");
  git("remote", "add", "origin", "https://dev.azure.com/office/Office/_git/1JS");
  const commit = git("rev-parse", "HEAD"), branch = git("symbolic-ref", "--short", "HEAD"), commands = [];
  let failure;
  const preparations = [];
  const adapter = codespaceRepositoryAdapter({
    files: options.files || [`${directory}/src/index.ts`],
    profile: { repoRoot: root, toolchainRoot: root, storageRoot: storage, baseBranch: "main", nodeExecutable: process.execPath },
    applicationRuntime: options.applicationRuntime,
    remoteTools: "/workspaces/.spool-review-tools", leaseToken: "a".repeat(36),
  }, {
    test: true, prepare: async (checkout, profile, input) => {
      preparations.push({ profile, input });
      if (failure === "prepare") throw new Error("Canonical preparation failed");
      if (failure === "setup" && input.operation === "setup") {
        fs.writeFileSync(path.join(root, "generated.tmp"), "Partial build output");
        throw new Error("Canonical setup failed");
      }
      if (input.reset) { git("reset", "--hard", "HEAD"); git("clean", "-fd"); }
      return { ready: true, buildWarmed: options.buildWarmed !== false, repoRoot: root,
        commit: options.wrongRevision ? "a".repeat(40) : await checkout.head(),
        branch: await checkout.branch(), steps: [{ name: "setup" }] };
    },
    applicationRuntime: async () => assert.fail("The runner must never start an application"),
    execute: async (command, args, options) => {
      if (command === "git") return execute(command, args, options);
      commands.push({ command, args, ...options });
      if (args.includes(failure)) throw new Error(`Required ${failure} failed`);
      return { stdout: "" };
    },
  });
  return { root, directory, commands, preparations, adapter, git, commit, branch,
    input: { repoRoot: root, operation: "branch", mode: "checkout", sourceCommit: commit, branch },
    fail: value => { failure = value; } };
}

test("native reviewer delegates checkout and explicitly pinned package setup to canonical repo_prepare", async t => {
  const f = fixture(t);
  const result = (await f.adapter.call("prepare", f.input)).structuredContent;
  assert.equal(result.ready, true);
  assert.deepEqual(f.commands, [], "Reviewer must not issue its own install or build commands");
  assert.equal(f.preparations.length, 2);
  assert.deepEqual(f.preparations[0].input, {
    ...f.input, baseBranch: "main", reset: true, runSetup: false, runBuild: false,
  });
  assert.deepEqual(f.preparations[1].input, {
    repoRoot: f.root, operation: "setup", packages: ["@1js/review-target"], runBuild: true,
  });
  assert.equal(result.preparationKind, "repository-prepare");
  assert.equal(fs.existsSync(path.join(f.root, "midgard", ".scoper")), false);
  assert.equal(fs.existsSync(path.join(f.root, ".git", "spool-review", "dependencies.json")), false);
});

test("native review checks every declared gate and cannot publish", async t => {
  const f = fixture(t);
  await f.adapter.call("prepare", f.input);
  f.commands.length = 0;
  const result = (await f.adapter.call("check", { repoRoot: f.root })).structuredContent;
  assert.deepEqual(f.commands.map(command => command.args),
    [["build"], ["lint"], ["typecheck"], ["test", "--runInBand"]]);
  assert.ok(f.commands.every(command => command.command === "yarn" && command.cwd === path.join(f.root, f.directory)));
  assert.equal(result.ready, true);
  assert.equal(result.runtimeEvidence, undefined);
  await assert.rejects(f.adapter.call("pr", { repoRoot: f.root }), /cannot publish/);
});

test("application packages are prepared without adding application-runtime setup or validation gates", async t => {
  const f = fixture(t, { application: true });
  const prepared = (await f.adapter.call("prepare", f.input)).structuredContent;
  assert.equal(prepared.validationPlan, undefined);
  assert.equal(prepared.runtimeEvidence, undefined);
  assert.deepEqual(f.commands, []);
  assert.equal(f.preparations.length, 2);
});

test("UI review does not install a shipping host, start an application or impose runtime gates", async t => {
  const f = fixture(t, { application: true, applicationRuntime: true });
  const response = await f.adapter.call("prepare", f.input), prepared = response.structuredContent;
  assert.equal(f.preparations.length, 2);
  assert.equal(prepared.runtimeEvidence, undefined);
  assert.doesNotMatch(response.content[0].text, /Authenticated application:/);
  assert.deepEqual(f.commands, []);
  await f.adapter.call("build", { repoRoot: f.root });
  await f.adapter.call("check", { repoRoot: f.root });
});

test("failed setup hands off the exact branch with honest failure evidence and leaves repair to the agent", async t => {
  const f = fixture(t);
  f.fail("setup");
  const response = await f.adapter.call("prepare", f.input), prepared = response.structuredContent;
  assert.equal(response.isError, false);
  assert.equal(prepared.ready, true);
  assert.equal(prepared.buildWarmed, false);
  assert.equal(prepared.buildError, "Canonical setup failed");
  assert.equal(prepared.commit, f.commit);
  assert.equal(prepared.branch, f.branch);
  assert.match(f.git("status", "--porcelain"), /generated.tmp/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, ".git", "spool-review", "prepare.json"))).buildWarmed, false);
  await assert.rejects(f.adapter.call("prepare", { repoRoot: f.root, operation: "setup" }), /Canonical setup failed/);
  f.fail(undefined);
  assert.equal((await f.adapter.call("prepare", { repoRoot: f.root, operation: "setup" })).structuredContent.buildWarmed, true);
  assert.equal(f.preparations.at(-1).input.reset, undefined);
});

test("an incomplete build does not block handoff but an unverified revision does", async t => {
  const incomplete = fixture(t, { buildWarmed: false });
  assert.equal((await incomplete.adapter.call("prepare", incomplete.input)).structuredContent.buildWarmed, false);
  const stale = fixture(t, { wrongRevision: true });
  await assert.rejects(stale.adapter.call("prepare", stale.input), /Canonical repository preparation/);
  assert.equal(fs.existsSync(path.join(stale.root, ".git", "spool-review", "prepare.json")), false);
});

test("failed canonical setup or agent-requested checks cannot produce passing evidence", async t => {
  const f = fixture(t);
  f.fail("prepare");
  await assert.rejects(f.adapter.call("prepare", f.input), /Canonical preparation failed/);
  assert.equal(fs.existsSync(path.join(f.root, ".git", "spool-review", "prepare.json")), false);
  f.fail(undefined);
  await f.adapter.call("prepare", f.input);
  f.fail("test");
  await assert.rejects(f.adapter.call("check", { repoRoot: f.root }), /Required test failed/);
  assert.equal(fs.existsSync(path.join(f.root, ".git", "spool-review", "check.json")), false);
});

test("review scope uses committed package identities and changefile owners without mutating source metadata", t => {
  const f = fixture(t), change = path.join(f.root, "midgard", "change", "example.json");
  fs.mkdirSync(path.dirname(change), { recursive: true });
  fs.writeFileSync(change, JSON.stringify({ changes: [{ packageName: "@1js/other-owner" }] }));
  f.git("add", ".");
  f.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "Changefile");
  fs.rmSync(path.join(f.root, f.directory, "package.json"));
  assert.deepEqual(reviewSourcePackageNames(f.root, [`${f.directory}/src/index.ts`, "midgard/change/example.json"]),
    ["@1js/other-owner", "@1js/review-target"]);
  assert.throws(() => reviewSourcePackageNames(f.root, ["midgard/package.json"]), /explicit scoped validation plan/);
  assert.throws(() => reviewSourcePackageNames(f.root, ["../outside"]), /invalid repository paths/);
});

test("deleted changefiles do not prevent discovering the current changed package scope", t => {
  const f = fixture(t), change = "midgard/change/deleted.json";
  fs.mkdirSync(path.join(f.root, "midgard", "change"));
  fs.writeFileSync(path.join(f.root, change), JSON.stringify({ changes: [{ packageName: "@1js/deleted-owner" }] }));
  f.git("add", ".");
  f.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "Add changefile");
  f.git("rm", change);
  f.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "Remove changefile");
  assert.deepEqual(reviewSourcePackageNames(f.root, [`${f.directory}/src/index.ts`, change]), ["@1js/review-target"]);
  assert.deepEqual(reviewSourcePackageNames(f.root, [change]), []);
});

test("review checkout hands off source even when optional setup cannot interpret changefile metadata", async t => {
  const file = "midgard/change/other-format.json";
  const f = fixture(t, { files: [file] });
  fs.mkdirSync(path.join(f.root, "midgard", "change"));
  fs.writeFileSync(path.join(f.root, file), JSON.stringify({ packageName: "@1js/review-target", type: "patch" }));
  f.git("add", file);
  f.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "Changefile");
  const commit = f.git("rev-parse", "HEAD");
  const prepared = (await f.adapter.call("prepare", { ...f.input, sourceCommit: commit, runBuild: false })).structuredContent;
  assert.equal(prepared.ready, true);
  assert.equal(prepared.commit, commit);
  assert.equal(prepared.buildWarmed, false);
  assert.match(prepared.buildError, /Invalid changefile/);
  assert.equal(f.git("rev-parse", "HEAD"), commit);
});

test("handoff evidence requires repository preparation and does not claim test or application validation", () => {
  const commit = "a".repeat(40), branch = "review/example";
  const saved = { version: 1, preparationKind: "repository-prepare",
    commit, sourceCommit: commit, branch, pr: { sourceCommit: commit },
    packagePreparation: { ready: true, preparationKind: "repository-prepare", buildWarmed: true,
      commit, branch, repoRoot: "/workspaces/1JS" } };
  assertPreparationEvidence(saved, { remoteRoot: "/workspaces/1JS" });
  assert.equal(saved.checks, undefined);
  assert.equal(saved.runtime, undefined);
  assert.throws(() => assertPreparationEvidence(saved, { remoteRoot: "/workspaces/other" }), /lacks/);
});

test("Git metadata parsing preserves byte lengths and refuses incomplete evidence", () => {
  const data = Buffer.from('{"owner":"\u00e9"}');
  const response = Buffer.concat([Buffer.from(`${"a".repeat(40)} blob ${data.length}\n`), data,
    Buffer.from("\nHEAD:missing missing\n")]);
  assert.deepEqual(readBatchBlobs(response, 2), [data, null]);
  assert.throws(() => readBatchBlobs(response.subarray(0, 20), 1), /Incomplete/);
});

test("a fresh review discards staged, unstaged and untracked changes through canonical preparation", async t => {
  const f = fixture(t), tracked = path.join(f.root, f.directory, "src", "index.ts");
  fs.writeFileSync(tracked, "export const value = 2;\n");
  f.git("add", ".");
  fs.writeFileSync(tracked, "export const value = 3;\n");
  fs.writeFileSync(path.join(f.root, "marketplace.json"), "{}");
  const result = (await f.adapter.call("prepare", f.input)).structuredContent;
  assert.equal(f.preparations[0].input.reset, true);
  assert.equal(fs.readFileSync(tracked, "utf8").replaceAll("\r\n", "\n"), "export const value = 1;\n");
  assert.equal(fs.existsSync(path.join(f.root, "marketplace.json")), false);
  assert.equal(f.git("status", "--porcelain"), "");
  assert.equal(result.commit, f.commit);
});
