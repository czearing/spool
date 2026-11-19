import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runRepositoryPreparation, prepareRepositoryCheckout } from "../src/adapters/1js-preparation.mjs";
import { repositoryProfile } from "../src/adapters/1js-profile.mjs";
import { repositoryAdapter, validateRepositoryInput } from "../src/adapters/1js.mjs";
import { tools } from "../../bohemia-pr-mcp/src/tools.ts";
import { openCheckout } from "../src/checkout.mjs";
import { rememberReadyPreparation, reuseReadyPreparation } from "../src/adapters/1js-preparation-cache.mjs";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "repository-preparation-"));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));
function fixture() {
  const storage = fs.mkdtempSync(path.join(scratch, "case-"));
  const remote = path.join(storage, "remote"), root = path.join(storage, "repo");
  fs.mkdirSync(remote);
  const git = (cwd, ...args) => execFileSync("git", args, {
    cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  git(remote, "init", "-b", "main");
  for (const cwd of [remote]) {
    git(cwd, "config", "user.name", "Fixture");
    git(cwd, "config", "user.email", "fixture@example.invalid");
  }
  fs.writeFileSync(path.join(remote, "base.txt"), "initial\n");
  git(remote, "add", "."); git(remote, "commit", "-m", "Initial");
  git(storage, "clone", remote, root);
  git(root, "config", "user.name", "Fixture");
  git(root, "config", "user.email", "fixture@example.invalid");
  const profile = repositoryProfile({ repoRoot: root, storageRoot: storage,
    nodeExecutable: process.execPath, baseBranch: "main" });
  const gates = [];
  const prepare = input => runRepositoryPreparation(profile, { repoRoot: root, ...input }, {
    authorize: async () => ({ environment: process.env, redactions: [] }),
    runGate: (verb, context) => gates.push({ verb, input: context.input }),
  });
  const commit = (cwd, file, text) => {
    fs.writeFileSync(path.join(cwd, file), text);
    git(cwd, "add", "."); git(cwd, "commit", "-m", `Change ${file}`);
    return git(cwd, "rev-parse", "HEAD");
  };
  return { profile, root, remote, git, gates, prepare, commit };
}

async function readyFixture() {
  const f = fixture(), pkg = path.join(f.root, "midgard", "packages", "test-package");
  fs.mkdirSync(path.join(pkg, "lib"), { recursive: true });
  fs.mkdirSync(path.join(f.root, "midgard", "node_modules"));
  fs.writeFileSync(path.join(f.root, "midgard", "package.json"), '{"private":true}');
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({
    name: "@1js/test-package", main: "lib/index.js", scripts: { build: "build-fixture" },
  }));
  fs.writeFileSync(path.join(pkg, "lib", "index.js"), "prepared output");
  f.commit(f.root, ".gitignore", "node_modules/\nlib/\n");
  const checkout = await openCheckout(f.root, {
    authorize: async () => ({ environment: process.env, redactions: [] }),
  });
  const input = { repoRoot: f.root, operation: "branch", mode: "resume", branch: "main",
    packages: ["@1js/test-package"] };
  const prepare = async () => {
    const result = await f.prepare(input);
    await rememberReadyPreparation(checkout, f.profile, input, result);
    return result;
  };
  await prepare();
  return { ...f, pkg, input, checkout, prepare,
    reuse: request => reuseReadyPreparation(checkout, f.profile, request || input) };
}

test("ready preparation reuses successful setup and build without invoking either gate again", async () => {
  const f = await readyFixture(), before = f.gates.length, started = performance.now();
  expect(await f.reuse()).toMatchObject({ cached: true, ready: true, buildWarmed: true });
  expect(await f.reuse({ ...f.input, operation: "setup" })).toMatchObject({ cached: true });
  expect(f.gates).toHaveLength(before);
  console.log(`Verified cached native preparation in ${Math.round(performance.now() - started)}ms`);
  expect(await f.reuse({ ...f.input, operation: "master" })).toBe(null);
  expect(await f.reuse({ ...f.input, packages: ["@1js/other"] })).toBe(null);
  expect(await f.reuse({ ...f.input, branch: "other" })).toBe(null);
  expect(await f.reuse({ ...f.input, expectedHead: "a".repeat(40) })).toBe(null);
});

test("preparation cache rejects worktree changes, branch changes, missing outputs and dependency changes", async () => {
  const f = await readyFixture(), output = path.join(f.pkg, "lib", "index.js");
  fs.writeFileSync(path.join(f.root, "untracked.txt"), "pending");
  expect(await f.reuse()).toBe(null);
  fs.rmSync(path.join(f.root, "untracked.txt"));
  expect((await f.reuse()).cached).toBe(true);
  f.git(f.root, "checkout", "-b", "other");
  expect(await f.reuse()).toBe(null);
  f.git(f.root, "checkout", "main");
  fs.rmSync(output);
  expect(await f.reuse()).toBe(null);
  fs.writeFileSync(output, "rebuilt output");
  await f.prepare();
  fs.writeFileSync(path.join(f.root, "midgard", "yarn.lock"), "changed dependencies");
  expect(await f.reuse()).toBe(null);
});

test("preparation cache checks fresh upstream heads and excludes partial or failed preparation", async () => {
  const f = await readyFixture();
  const network = f.checkout.networkGit;
  f.checkout.networkGit = async () => "";
  expect(await f.reuse()).toBe(null);
  f.checkout.networkGit = network;
  f.commit(f.remote, "upstream.txt", "new main");
  expect(await f.reuse()).toBe(null);
  expect(await f.reuse({ ...f.input, operation: "setup" })).not.toBe(null);
  for (const change of [{ ready: false }, { buildWarmed: false }, { merge: { conflicted: true } }]) {
    await rememberReadyPreparation(f.checkout, f.profile, f.input, {
      ready: true, buildWarmed: true, commit: await f.checkout.head(), branch: "main", ...change,
    });
    expect(await f.reuse()).toBe(null);
  }
});

test("stock scoped installations can cache private manifests without requiring unused transitive developer tools", async () => {
  const f = await readyFixture();
  const dependency = path.join(f.root, "midgard", "node_modules", "@1js", "private-dependency");
  fs.mkdirSync(dependency, { recursive: true });
  fs.writeFileSync(path.join(dependency, "package.json"), JSON.stringify({
    name: "@1js/private-dependency", main: "index.js", exports: { ".": "./index.js" },
    devDependencies: { "@1js/unused-development-tool": "*" },
    optionalDependencies: { "@1js/optional-runtime": "*" },
  }));
  fs.writeFileSync(path.join(dependency, "index.js"), "module.exports = {};");
  const manifest = JSON.parse(fs.readFileSync(path.join(f.pkg, "package.json")));
  manifest.dependencies = { "@1js/private-dependency": "*" };
  f.commit(f.root, path.relative(f.root, path.join(f.pkg, "package.json")), JSON.stringify(manifest));
  await f.prepare();
  expect((await f.reuse()).cached).toBe(true);
  const optional = path.join(dependency, "node_modules", "@1js", "optional-runtime");
  fs.mkdirSync(optional, { recursive: true });
  fs.writeFileSync(path.join(optional, "package.json"), '{"name":"@1js/optional-runtime"}');
  expect(await f.reuse()).toBe(null);
});

test("adapter invalidates previous readiness before a failed setup and retains normal failure behavior", async () => {
  const f = await readyFixture();
  const adapter = repositoryAdapter({ repoRoot: f.root, storageRoot: f.profile.storageRoot,
    nodeExecutable: process.execPath, baseBranch: "main" }, {
    openCheckout: async () => ({ ...f.checkout, assertRemote: async () => {} }),
    prepare: async () => { throw new Error("setup failed"); },
  });
  expect((await adapter.call("prepare", f.input)).structuredContent.cached).toBe(true);
  await expect(adapter.call("prepare", { ...f.input, runBuild: false })).rejects.toThrow("setup failed");
  expect(await f.reuse()).toBe(null);
});

test("native branch creation follows requested main without selecting or downloading a CI baseline", async () => {
  const f = fixture();
  const latest = f.commit(f.remote, "latest.txt", "native main\n");
  const result = await f.prepare({ operation: "branch", mode: "create", branch: "native-topic", runSetup: false });
  expect(result.commit).toBe(latest);
  expect(result.ciBaseline).toBeUndefined();
  expect(f.gates).toEqual([]);
});

test("adapter prepares the next pinned review from a detached checkout", async () => {
  const f = fixture();
  fs.mkdirSync(f.profile.workspaceRoot, { recursive: true });
  fs.writeFileSync(path.join(f.profile.workspaceRoot, "package.json"), '{"private":true}');
  const source = f.commit(f.root, "review.txt", "review source\n");
  f.git(f.root, "checkout", "--detach", source);
  const checkout = await openCheckout(f.root);
  expect(await checkout.branch()).toBe("");
  const adapter = repositoryAdapter({ repoRoot: f.root, storageRoot: f.profile.storageRoot,
    nodeExecutable: process.execPath, baseBranch: "main" }, {
    openCheckout: async () => ({ ...checkout, assertRemote: async () => {} }),
    prepare: async (_checkout, _profile, input) => f.prepare(input),
  });
  const result = (await adapter.call("prepare", { repoRoot: f.root, operation: "branch", mode: "checkout",
    sourceCommit: source, branch: "review/next-pr", runSetup: false, runBuild: false })).structuredContent;
  expect(result).toMatchObject({ ready: true, commit: source, branch: "review/next-pr" });
  expect(await checkout.branch()).toBe("review/next-pr");
  expect(await checkout.head()).toBe(source);
});

















test("1JS exposes the original Bohemia preparation contract with its repository base", async () => {
  const f = fixture();
  const adapter = repositoryAdapter({ repoRoot: f.root, storageRoot: f.profile.storageRoot,
    nodeExecutable: process.execPath, baseBranch: "main" });
  const actual = (await adapter.tools()).find(tool => tool.operation === "prepare").inputSchema;
  const original = tools.find(tool => tool.name === "bohemia_prepare").inputSchema;
  for (const [field, schema] of Object.entries(original.properties)) {
    if (["repoRoot", "baseBranch", "seedRoot", "operation"].includes(field)) continue;
    expect(actual.properties[field]).toBe(schema);
  }
  expect(actual.properties.operation).toBe(original.properties.operation);
  expect(actual.properties.baseBranch.default).toBe("main");
  expect(actual.properties.seedRoot).toBeUndefined();
  expect(() => validateRepositoryInput("prepare", { repoRoot: f.root, operation: "setup", seedRoot: f.root }))
    .toThrow("Unsupported");
  expect(original.properties.baseBranch.default).toBe("master");
  for (const input of [
    { operation: "branch", branch: "topic", mergeMaster: true },
    { operation: "master" },
    { operation: "setup", runBuild: false },
    { operation: "branch", branch: "review", sourceCommit: "a".repeat(40), mode: "checkout" },
  ]) expect(() => validateRepositoryInput("prepare", { repoRoot: f.root, ...input })).not.toThrow();
  expect(() => validateRepositoryInput("prepare", { repoRoot: f.root, operation: "branch",
    branch: "topic", mode: "resume", reset: true })).toThrow("Reset");
});

test("branch preparation merges the refreshed target and records the exact merge commit", async () => {
  const f = fixture();
  f.git(f.remote, "checkout", "-b", "topic");
  const source = f.commit(f.remote, "topic.txt", "topic\n");
  f.git(f.remote, "checkout", "main");
  const target = f.commit(f.remote, "target.txt", "target\n");
  const result = await f.prepare({ operation: "branch", branch: "topic", mode: "checkout",
    expectedHead: source, mergeMaster: true });
  expect(result.ready).toBe(true);
  expect(result.merge).toMatchObject({ merged: true, conflicted: false, targetCommit: target });
  expect(f.git(f.root, "show", "HEAD:target.txt")).toBe("target");
  expect(f.gates.map(gate => gate.verb)).toEqual(["setup"]);
  expect(f.git(f.root, "status", "--porcelain")).toBe("");
});

test("conflict admission installs the clean PR revision before creating its target merge", async () => {
  const f = fixture();
  f.git(f.remote, "checkout", "-b", "topic");
  const source = f.commit(f.remote, "base.txt", "topic\n");
  f.git(f.remote, "checkout", "main");
  f.commit(f.remote, "base.txt", "main\n");
  let setups = 0;
  const result = await runRepositoryPreparation(f.profile, { repoRoot: f.root, operation: "branch",
    branch: "topic", mode: "checkout", reset: true, expectedHead: source,
    mergeMaster: true, allowConflicts: true, runBuild: false }, {
    authorize: async () => ({ environment: process.env, redactions: [] }),
    runGate: verb => {
      expect(verb).toBe("setup");
      expect(fs.existsSync(path.join(f.root, ".git", "MERGE_HEAD"))).toBe(false);
      expect(f.git(f.root, "rev-parse", "HEAD")).toBe(source);
      expect(fs.readFileSync(path.join(f.root, "base.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("topic\n");
      setups++;
    },
  });
  expect(setups).toBe(1);
  expect(result.merge).toMatchObject({ conflicted: true, setupBeforeMerge: true, files: ["base.txt"] });
  expect(result.steps.findIndex(step => step.name === "setup")).toBeLessThan(
    result.steps.findIndex(step => step.name === "merge-master"));
  expect(result.ready).toBe(true);
  expect(result.buildWarmed).toBe(false);
});

test("master refresh fetches the base without switching, merging, or running setup", async () => {
  const f = fixture();
  await f.prepare({ operation: "branch", branch: "topic", mode: "create", runSetup: false });
  const before = f.git(f.root, "rev-parse", "HEAD");
  const target = f.commit(f.remote, "new.txt", "new\n");
  const result = await f.prepare({ operation: "master" });
  expect(result.commit).toBe(before);
  expect(result.branch).toBe("topic");
  expect(f.git(f.root, "rev-parse", "origin/main")).toBe(target);
  expect(f.gates).toEqual([]);
});

test("resume preserves unpublished commits and merges only when explicitly requested", async () => {
  const f = fixture();
  f.git(f.remote, "checkout", "-b", "topic");
  f.commit(f.remote, "topic.txt", "topic\n");
  f.git(f.remote, "checkout", "main");
  await f.prepare({ operation: "branch", branch: "topic", runSetup: false });
  const local = f.commit(f.root, "local.txt", "local\n");
  const target = f.commit(f.remote, "target.txt", "target\n");
  const resumed = await f.prepare({ operation: "branch", branch: "topic", mode: "resume", runSetup: false });
  expect(resumed.commit).toBe(local);
  expect(resumed.merge).toBe(null);
  const merged = await f.prepare({ operation: "branch", branch: "topic", mode: "resume",
    mergeMaster: true, runSetup: false });
  expect(merged.merge.targetCommit).toBe(target);
  expect(f.git(f.root, "show", "HEAD:local.txt")).toBe("local");
});

test("native resume preserves a never-pushed branch and unpublished commits", async () => {
  const f = fixture();
  await f.prepare({ operation: "branch", branch: "local-topic", mode: "create", runSetup: false });
  const local = f.commit(f.root, "authored.txt", "unpublished work\n");
  const target = f.commit(f.remote, "target.txt", "new main\n");
  const result = await f.prepare({ operation: "branch", branch: "local-topic", mode: "resume", runSetup: false });
  expect(result.commit).toBe(local);
  expect(result.branch).toBe("local-topic");
  expect(result.merge).toBe(null);
  expect(f.git(f.root, "rev-parse", "origin/main")).toBe(target);
  expect(f.git(f.root, "ls-remote", "--heads", "origin", "refs/heads/local-topic")).toBe("");
  expect(f.git(f.root, "show", "HEAD:authored.txt")).toBe("unpublished work");
  await expect(f.prepare({ operation: "branch", branch: "local-topic", mode: "resume",
    expectedHead: local, runSetup: false })).rejects.toThrow("PR head changed");
  fs.writeFileSync(path.join(f.root, "authored.txt"), "pending edit\n");
  await expect(f.prepare({ operation: "branch", branch: "local-topic", mode: "resume",
    runSetup: false })).rejects.toThrow("dirty");
  expect(fs.readFileSync(path.join(f.root, "authored.txt"), "utf8")).toBe("pending edit\n");
});

test("native checkout restores a never-pushed local branch and requires explicit reset for dirty work", async () => {
  const f = fixture();
  await f.prepare({ operation: "branch", branch: "local-topic", mode: "create", runSetup: false });
  const local = f.commit(f.root, "authored.txt", "unpublished work\n");
  f.git(f.root, "checkout", "main");
  fs.writeFileSync(path.join(f.root, "untracked.txt"), "pending work\n");
  const input = { operation: "branch", branch: "local-topic", mode: "checkout", runSetup: false };
  await expect(f.prepare(input)).rejects.toThrow("dirty");
  expect(f.git(f.root, "branch", "--show-current")).toBe("main");
  expect(fs.readFileSync(path.join(f.root, "untracked.txt"), "utf8")).toBe("pending work\n");
  const restored = await f.prepare({ ...input, reset: true });
  expect(restored.branch).toBe("local-topic");
  expect(restored.commit).toBe(local);
  expect(f.git(f.root, "show", "HEAD:authored.txt")).toBe("unpublished work");
  expect(fs.existsSync(path.join(f.root, "untracked.txt"))).toBe(false);
  expect(f.gates).toEqual([]);
});

test("exact revision, expected remote head, and dirty checkout protections match Bohemia", async () => {
  const f = fixture();
  const source = f.git(f.remote, "rev-parse", "HEAD");
  const review = await f.prepare({ operation: "branch", branch: "review/topic", mode: "checkout",
    sourceCommit: source, runSetup: false });
  expect(review.commit).toBe(source);
  fs.writeFileSync(path.join(f.root, "base.txt"), "authored\n");
  await expect(f.prepare({ operation: "branch", branch: "review/topic", mode: "resume",
    runSetup: false })).rejects.toThrow("dirty");
  expect(fs.readFileSync(path.join(f.root, "base.txt"), "utf8")).toBe("authored\n");
  await expect(f.prepare({ operation: "branch", branch: "main", expectedHead: "a".repeat(40),
    runSetup: false })).rejects.toThrow("PR head changed");
  expect(f.gates).toEqual([]);
});

test("explicit clean checkout discards finished work and resets a diverged branch to the PR head", async () => {
  const f = fixture();
  f.git(f.remote, "checkout", "-b", "topic");
  f.commit(f.remote, "topic.txt", "original\n");
  await f.prepare({ operation: "branch", branch: "topic", mode: "checkout", runSetup: false });
  f.commit(f.root, "local.txt", "unpublished\n");
  const source = f.commit(f.remote, "topic.txt", "updated PR\n");
  f.git(f.root, "checkout", "main");
  fs.writeFileSync(path.join(f.root, "base.txt"), "leftover edit\n");
  fs.writeFileSync(path.join(f.root, "untracked.txt"), "leftover file\n");
  const result = await f.prepare({ operation: "branch", branch: "topic", mode: "checkout",
    reset: true, expectedHead: source, runSetup: false });
  expect(result.commit).toBe(source);
  expect(result.branch).toBe("topic");
  expect(f.git(f.root, "status", "--porcelain")).toBe("");
  expect(fs.existsSync(path.join(f.root, "untracked.txt"))).toBe(false);
  expect(fs.existsSync(path.join(f.root, "local.txt"))).toBe(false);
});

test("fresh exact-revision checkout discards generated files ignored only by the previous branch", async () => {
  const f = fixture(), source = f.git(f.remote, "rev-parse", "HEAD");
  f.commit(f.root, ".gitignore", "generated.css.d.ts\n");
  fs.writeFileSync(path.join(f.root, "generated.css.d.ts"), "old generated output\n");
  fs.appendFileSync(path.join(f.root, ".git", "info", "exclude"), "\ncache/\n");
  fs.mkdirSync(path.join(f.root, "cache"));
  fs.writeFileSync(path.join(f.root, "cache", "dependency"), "retained\n");
  const result = await f.prepare({ operation: "branch", branch: "review/exact", mode: "checkout",
    sourceCommit: source, reset: true, runSetup: false });
  expect(result.commit).toBe(source);
  expect(f.git(f.root, "status", "--porcelain")).toBe("");
  expect(fs.existsSync(path.join(f.root, "generated.css.d.ts"))).toBe(false);
  expect(fs.readFileSync(path.join(f.root, "cache", "dependency"), "utf8")).toBe("retained\n");
});

test("clean conflict restoration discards an old merge and recreates only the requested PR conflict", async () => {
  const f = fixture();
  f.git(f.remote, "checkout", "-b", "topic");
  const source = f.commit(f.remote, "base.txt", "topic\n");
  f.git(f.remote, "checkout", "main");
  f.commit(f.remote, "base.txt", "main\n");
  const input = { operation: "branch", branch: "topic", mode: "checkout", reset: true,
    expectedHead: source, mergeMaster: true, allowConflicts: true, runSetup: false };
  await f.prepare(input);
  fs.writeFileSync(path.join(f.root, "leftover.txt"), "finished task residue\n");
  const result = await f.prepare(input);
  expect(result.commit).toBe(source);
  expect(result.merge.conflicted).toBe(true);
  expect(result.merge.resumed).toBeUndefined();
  expect(result.merge.files).toEqual(["base.txt"]);
  expect(fs.existsSync(path.join(f.root, "leftover.txt"))).toBe(false);
});

test("conflicts and interrupted conflict resumes retain the original Bohemia recovery flow", async () => {
  const f = fixture();
  f.git(f.remote, "checkout", "-b", "topic");
  const source = f.commit(f.remote, "base.txt", "topic\n");
  f.git(f.remote, "checkout", "main");
  const target = f.commit(f.remote, "base.txt", "main\n");
  const first = await f.prepare({ operation: "branch", branch: "topic", mode: "checkout",
    expectedHead: source, mergeMaster: true, allowConflicts: true, runSetup: false });
  expect(first.merge).toMatchObject({ conflicted: true, targetCommit: target, files: ["base.txt"] });
  const resumed = await f.prepare({ operation: "branch", branch: "topic", mode: "resume",
    expectedHead: source, mergeMaster: true, allowConflicts: true, runSetup: false });
  expect(resumed.merge).toMatchObject({ conflicted: true, resumed: true, targetCommit: target });
  expect(f.git(f.root, "rev-parse", "HEAD")).toBe(source);
});

test("setup failures cannot leave a passing handoff and release both preparation ownership and state", async () => {
  const f = fixture();
  await expect(runRepositoryPreparation(f.profile, { repoRoot: f.root, operation: "setup" }, {
    authorize: async () => ({ environment: process.env, redactions: [] }),
    runGate: () => { throw new Error("CI prerequisite missing"); },
  })).rejects.toThrow("CI prerequisite missing");
  const directory = path.join(f.root, ".git");
  expect(JSON.parse(fs.readFileSync(path.join(directory, "bohemia-preparation.json"), "utf8")))
    .toMatchObject({ state: "failed", stage: "setup" });
  expect(fs.existsSync(path.join(directory, "bohemia-workspace.lock"))).toBe(false);
});

test("preparation subprocess errors retain the typed safe-checkout recovery contract", async () => {
  const f = fixture();
  const checkout = { receiptPath: name => path.join(f.root, ".git", "repository-mcp", name) };
  const input = { repoRoot: f.root, operation: "branch", mode: "resume", branch: "other" };
  const error = await prepareRepositoryCheckout(checkout, f.profile, input, async () => ({
    stdout: JSON.stringify({ error: { message: "Resume branch does not match",
      code: "BOHEMIA_PREPARATION_BLOCKED", reasonCode: "branch_mismatch" } }),
  })).catch(error => error);
  expect(error).toBeInstanceOf(Error);
  expect(error.code).toBe("BOHEMIA_PREPARATION_BLOCKED");
  expect(error.reasonCode).toBe("branch_mismatch");
  expect(error.message).toContain("Resume branch does not match");
  expect(error.message).toContain("log:");
});
