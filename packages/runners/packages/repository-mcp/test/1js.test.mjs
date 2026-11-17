import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { repositoryAdapter, repositoryTools, validateRepositoryInput } from "../src/adapters/1js.mjs";
import { repositoryProfile } from "../src/adapters/1js-profile.mjs";
import { setupRepository } from "../src/adapters/1js-setup.mjs";
import { selectedPackages } from "../src/adapters/1js-packages.mjs";
import { listTools, callTool } from "../src/registry.mjs";
import { openCheckout } from "../src/checkout.mjs";
import { execute, withWorkspaceLock, writeReceipt } from "../src/process.mjs";
import { HEADINGS } from "../../bohemia-pr-mcp/src/render.ts";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "1js-global-"));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));
async function fixture() {
  const storage = fs.mkdtempSync(path.join(scratch, "case-")), root = path.join(storage, "repo");
  const first = "midgard/packages/arbitrary-one", second = "other-area/packages/arbitrary-two";
  fs.mkdirSync(path.join(root, first, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, second, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "midgard", "package.json"), "{}");
  for (const [directory, name] of [[first, "@1js/arbitrary-one"], [second, "@1js/arbitrary-two"]]) {
    fs.writeFileSync(path.join(root, directory, "package.json"), JSON.stringify({ name,
      scripts: { build: "builder", bundle: "bundler", lint: "linter", typecheck: "checker", test: "vitest" } }));
    fs.writeFileSync(path.join(root, directory, "src", "index.ts"), "export const value = 1;\n");
  }
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  git("add", "."); git("commit", "-m", "Base");
  const base = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/main", base);
  git("remote", "add", "origin", "https://dev.azure.com/office/Office/_git/1JS");
  git("checkout", "-b", "user/test/topic");
  const config = { repoRoot: root, toolchainRoot: root, storageRoot: storage, baseBranch: "main", nodeExecutable: process.execPath };
  const commands = [], checkout = await openCheckout(root), profile = repositoryProfile(config);
  let failure, remote, published;
  checkout.fetch = async () => base;
  checkout.networkGit = async (...args) => {
    if (args[0] === "push") { remote = await checkout.head(); return ""; }
    return checkout.git(...args);
  };
  const host = {
    tip: async branch => branch === "main" ? base : remote,
    list: async () => [],
    get: async () => structuredClone(published),
    create: async fields => (published = { ...fields, pullRequestId: 101, status: "active" }),
    update: async (_id, fields) => (published = { ...published, ...fields }),
    url: () => "https://example.invalid/pullrequest/101",
  };
  const run = async (command, args, options) => {
    commands.push({ command, args, ...options });
    if (args[0] === failure) throw new Error(`Required ${failure} failed`);
    return { stdout: "" };
  };
  const adapter = repositoryAdapter(config, { openCheckout: async () => checkout, execute: run,
    host, notify: async () => "fixture" });
  return { root, first, second, config, profile, checkout, adapter, commands, git, run,
    published: () => published, remote: () => remote, fail: value => { failure = value; },
    commit: (directory = second) => {
      fs.writeFileSync(path.join(root, directory, "src", "index.ts"), "export const value = 2;\n");
      git("add", "."); git("commit", "-m", "Retain selected values");
    } };
}

test("the MCP advertises exactly four tools and rejects removed tools rather than keeping aliases", async () => {
  const f = await fixture();
  expect((await listTools([f.adapter])).map(tool => tool.name))
    .toEqual(["repo_prepare", "repo_build", "repo_check", "repo_pr"]);
  for (const operation of ["add_packages", "start"]) {
    await expect(callTool([f.adapter], { name: `repo_${operation}`, arguments: { repo: "1js", input: { repoRoot: f.root } } }))
      .rejects.toThrow("Unknown repository tool");
    expect(() => validateRepositoryInput(operation, { repoRoot: f.root })).toThrow("Unsupported");
  }
  expect(repositoryTools().flatMap(tool => Object.keys(tool.inputSchema.properties)))
    .not.toContain("performanceBoundary");
  const pr = repositoryTools().find(tool => tool.operation === "pr").inputSchema;
  expect(pr.required).toEqual(["repoRoot"]);
  expect(pr.oneOf[0].required).toContain("uiChange");
  expect(pr.oneOf[1].required).toEqual(["pullRequestId"]);
  expect(() => repositoryProfile(f.config, ".")).toThrow("repoRoot must be absolute");
});

test("PR content is validated before checkout access, authentication or package commands", async () => {
  const f = await fixture();
  let opened = false;
  const adapter = repositoryAdapter(f.config, { openCheckout: async () => { opened = true; return f.checkout; } });
  await expect(adapter.call("pr", { repoRoot: f.root, category: "fix", title: "Keep selection",
    problem: "Selection resets.", solution: "Preserve selection", validation: "Checks passed.", uiChange: false }))
    .rejects.toThrow("solution must end with a full stop");
  expect(opened).toBe(false);
  expect(f.commands).toHaveLength(0);
});

test("publication infers create, the current branch and arbitrary changed packages", async () => {
  const f = await fixture();
  f.commit();
  const result = await f.adapter.call("pr", { repoRoot: f.root, category: "fix", title: "Retain selected values",
    problem: "Selected values reset.", solution: "Selected values are retained.",
    validation: "Focused checks passed.", uiChange: false });
  expect(result.structuredContent.ready).toBe(true);
  expect(f.published().sourceRefName).toBe("refs/heads/user/test/topic");
  expect(f.commands.every(command => command.cwd === path.join(f.root, f.second))).toBe(true);
});

test("explicit package selection is global, checkout-local and does not require admission state", async () => {
  const f = await fixture();
  writeReceipt(path.join(f.profile.stateRoot, "package-scope.json"),
    { version: 1, repoRoot: f.root, status: "pending", packages: ["@1js/m365-copilot-app-library"] });
  const result = await f.adapter.call("build", { repoRoot: f.root, packages: ["arbitrary-two"] });
  expect(result.structuredContent.packages).toEqual(["@1js/arbitrary-two"]);
  expect(f.commands.map(({ args, cwd }) => ({ args, cwd })))
    .toEqual([{ args: ["build"], cwd: path.join(f.root, f.second) }]);
  f.commands.length = 0;
  await f.adapter.call("check", { repoRoot: f.root, packages: ["@1js/arbitrary-one"] });
  expect(f.commands.map(command => command.args)).toEqual([["build"], ["bundle"], ["lint"], ["typecheck"], ["test", "--run"]]);
  expect(f.commands.every(command => command.cwd === path.join(f.root, f.first))).toBe(true);
});

test("an unrelated tracked manifest absent from the checkout cannot block explicit package setup", async () => {
  const f = await fixture(), missing = path.join(f.root, "1js-wiki", "package.json");
  fs.mkdirSync(path.dirname(missing));
  fs.writeFileSync(missing, JSON.stringify({ name: "@1js/wiki" }));
  f.git("add", "1js-wiki/package.json");
  f.git("commit", "-m", "Track documentation package");
  fs.unlinkSync(missing);
  const result = await setupRepository(f.profile, { packages: ["@1js/arbitrary-two"], runBuild: false }, "setup",
    { openCheckout: async () => f.checkout, execute: f.run });
  expect(result.packages).toEqual(["@1js/arbitrary-two"]);
  expect(f.commands.map(({ args, cwd }) => ({ args, cwd }))).toEqual([
    { args: ["fast", "@1js/arbitrary-two"], cwd: path.join(f.root, "midgard") },
    { args: ["patch-dependencies"], cwd: path.join(f.root, "midgard") },
  ]);
  await expect(selectedPackages(f.checkout, f.profile, { packages: ["@1js/wiki"] }))
    .rejects.toThrow("existing checked-out");
});

test("explicit selection still rejects malformed checked-out manifests without running commands", async () => {
  const f = await fixture();
  fs.writeFileSync(path.join(f.root, f.first, "package.json"), "{");
  await expect(f.adapter.call("build", { repoRoot: f.root, packages: ["@1js/arbitrary-one"] }))
    .rejects.toThrow();
  expect(f.commands).toHaveLength(0);
});

test("shared setup replaces obsolete patched cache entries before invoking the unchanged stock installer", async () => {
  const f = await fixture(), before = f.git("rev-parse", "HEAD");
  const patches = path.join(f.root, "midgard", "packages", "patch-dependencies", "patches", "sample");
  const cached = path.join(f.root, "midgard", ".store", "sample@1.0.0-old");
  fs.mkdirSync(patches, { recursive: true });
  fs.writeFileSync(path.join(patches, "sample+1.0.0.patch"), "Current revision's stock patch");
  fs.mkdirSync(path.join(cached, "node_modules", "sample"), { recursive: true });
  fs.writeFileSync(path.join(cached, "node_modules", "sample", "package.json"),
    JSON.stringify({ name: "sample", version: "1.0.0" }));
  fs.mkdirSync(path.join(cached, ".patch-dependencies"));
  fs.writeFileSync(path.join(cached, ".patch-dependencies", `${"f".repeat(64)}.done`), "");
  await expect(setupRepository(f.profile, { packages: ["@1js/arbitrary-one"], runBuild: false }, "setup", {
    openCheckout: async () => f.checkout,
    execute: async (_command, args) => {
      expect(args).toEqual(["fast", "@1js/arbitrary-one"]);
      expect(fs.existsSync(cached)).toBe(false);
      throw new Error("Stock installer reached");
    },
  })).rejects.toThrow("Stock installer reached");
  expect(f.git("rev-parse", "HEAD")).toBe(before);
  expect(f.git("diff", "--name-only")).toBe("");
});

test("changed-file discovery validates a package outside Library and outside Midgard without an allowlist", async () => {
  const f = await fixture(); f.commit();
  const result = await f.adapter.call("check", { repoRoot: f.root });
  expect(result.structuredContent.packages).toEqual(["@1js/arbitrary-two"]);
  expect(f.commands.every(command => command.cwd === path.join(f.root, f.second))).toBe(true);
  expect(f.commands.some(command => command.cwd === f.root || command.cwd === path.join(f.root, "midgard"))).toBe(false);
});

test("conflict setup scopes the PR source rather than unrelated target-branch merge changes", async () => {
  const f = await fixture();
  f.commit(f.first);
  const infrastructure = path.join(f.root, ".azuredevops", "branchpolicies", "midgard", "main.yml");
  fs.mkdirSync(path.dirname(infrastructure), { recursive: true });
  fs.writeFileSync(infrastructure, "unrelated target change\n");
  f.git("add", ".azuredevops");
  const result = await setupRepository(f.profile, {
    operation: "branch", mergeMaster: true, allowConflicts: true, runBuild: false,
  }, "setup", { openCheckout: async () => f.checkout, execute: f.run });
  expect(result.packages).toEqual(["@1js/arbitrary-one"]);
  expect(f.commands[0].args).toEqual(["fast", "@1js/arbitrary-one"]);
  await expect(setupRepository(f.profile, { runBuild: false }, "setup",
    { openCheckout: async () => f.checkout, execute: f.run })).rejects.toThrow("explicit scoped packages");
});

for (const script of ["prepare", "build"])
test(`repair setup refreshes Jest through its revision's stock ${script} without building conflicted application code`, async () => {
  const f = await fixture(), manifestFile = path.join(f.root, f.first, "package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  fs.writeFileSync(manifestFile, JSON.stringify({ ...manifest, devDependencies: { "@1js/jest-config": "*" } }));
  const toolRoot = path.join(f.root, f.first, "node_modules", "@1js", "jest-config");
  fs.mkdirSync(toolRoot, { recursive: true });
  fs.writeFileSync(path.join(toolRoot, "package.json"),
    JSON.stringify({ name: "@1js/jest-config", scripts: { [script]: script === "prepare" ? "run-transpile --compiler swc" : "tsc" } }));
  const result = await setupRepository(f.profile, { packages: [manifest.name], runBuild: false }, "setup",
    { openCheckout: async () => f.checkout, execute: f.run });
  expect(result.steps.map(step => step.name)).toEqual([
    "scoped-install", "dependency-patches", "test-toolchain", "test-toolchain-verification"]);
  expect(f.commands.at(-2).args).toEqual([script]);
  expect(f.commands.at(-2).cwd).toEqual(fs.realpathSync(toolRoot));
  expect(f.commands.at(-1).args).toEqual(["-e", 'require("@1js/jest-config")']);
  expect(f.commands.at(-1).cwd).toBe(path.join(f.root, f.first));
  expect(f.commands.some(command => command.args[0] === "build" && command.cwd !== fs.realpathSync(toolRoot))).toBe(false);
});

test("Jest refresh invalidates only generated incremental metadata after upstream cache restoration", async () => {
  const f = await fixture(), manifestFile = path.join(f.root, f.first, "package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  fs.writeFileSync(manifestFile, JSON.stringify({ ...manifest, devDependencies: { "@1js/jest-config": "*" } }));
  const toolRoot = path.join(f.root, f.first, "node_modules", "@1js", "jest-config");
  const info = path.join(toolRoot, "lib", "tsconfig.tsbuildinfo");
  fs.mkdirSync(path.dirname(info), { recursive: true });
  fs.writeFileSync(path.join(toolRoot, "package.json"),
    JSON.stringify({ name: "@1js/jest-config", scripts: { build: "tsc" } }));
  fs.writeFileSync(path.join(toolRoot, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { outDir: "lib", tsBuildInfoFile: "lib/tsconfig.tsbuildinfo" } }));
  const compiler = path.join(toolRoot, "node_modules", "typescript");
  fs.mkdirSync(compiler, { recursive: true });
  fs.writeFileSync(path.join(compiler, "index.js"),
    'exports.sys = { readFile: file => require("node:fs").readFileSync(file, "utf8") }; ' +
    'exports.readConfigFile = (file, read) => ({ config: JSON.parse(read(file)) });');
  fs.writeFileSync(path.join(f.profile.workspaceRoot, "package.json"),
    JSON.stringify({ scripts: { "build-scope": "yarn lage build --to" } }));
  const run = async (command, args, options) => {
    if (args[0] === "build-scope") fs.writeFileSync(info, "stale branch metadata");
    if (args[0] === "build" && options.cwd === fs.realpathSync(toolRoot))
      expect(fs.existsSync(info)).toBe(false);
    return f.run(command, args, options);
  };
  await setupRepository(f.profile, { packages: [manifest.name] }, "setup",
    { openCheckout: async () => f.checkout, execute: run });
  expect(f.commands.map(command => command.args[0]))
    .toEqual(["fast", "patch-dependencies", "build-scope", "build", "-e"]);
  f.fail("-e");
  await expect(setupRepository(f.profile, { packages: [manifest.name] }, "setup",
    { openCheckout: async () => f.checkout, execute: run })).rejects.toThrow("Required -e failed");
});

test("automatic scope includes uncommitted and new package files before the agent makes a commit", async () => {
  const f = await fixture();
  fs.writeFileSync(path.join(f.root, f.second, "src", "index.ts"), "export const value = 2;\n");
  fs.writeFileSync(path.join(f.root, f.first, "src", "new.ts"), "export const added = true;\n");
  const result = await f.adapter.call("check", { repoRoot: f.root });
  expect(result.structuredContent.packages.sort()).toEqual(["@1js/arbitrary-one", "@1js/arbitrary-two"]);
  expect(f.commands.every(command => [path.join(f.root, f.first), path.join(f.root, f.second)].includes(command.cwd))).toBe(true);
});

test("a branch change at the same commit cannot produce a passing check receipt", async () => {
  const f = await fixture();
  const adapter = repositoryAdapter(f.config, { openCheckout: async () => f.checkout,
    execute: async () => { f.git("checkout", "-B", "other-branch"); return { stdout: "" }; } });
  await expect(adapter.call("check", { repoRoot: f.root, packages: ["@1js/arbitrary-two"] }))
    .rejects.toThrow("Checkout branch or HEAD changed");
  expect(fs.existsSync(f.checkout.receiptPath("check.json"))).toBe(false);
});

test("package selection is not restricted to the Library package or the 1js namespace", async () => {
  const f = await fixture(), file = path.join(f.root, f.second, "package.json");
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  manifest.name = "@another-scope/arbitrary-two";
  fs.writeFileSync(file, JSON.stringify(manifest));
  const result = await f.adapter.call("build", { repoRoot: f.root, packages: [manifest.name] });
  expect(result.structuredContent.packages).toEqual([manifest.name]);
  expect(f.commands[0].cwd).toBe(path.join(f.root, f.second));
});

test("stock preparation installs only the requested dependency closure and warms only selected packages", async () => {
  const f = await fixture();
  const result = await setupRepository(f.profile, { packages: ["@1js/arbitrary-two"], runBuild: false }, "setup",
    { openCheckout: async () => f.checkout, execute: f.run });
  expect(result.buildWarmed).toBe(false);
  expect(f.commands.map(({ args, cwd }) => ({ args, cwd }))).toEqual([
    { args: ["fast", "@1js/arbitrary-two"], cwd: path.join(f.root, "midgard") },
    { args: ["patch-dependencies"], cwd: path.join(f.root, "midgard") },
  ]);
  expect(fs.existsSync(path.join(f.profile.stateRoot, "package-scope.json"))).toBe(false);
});

test("stock install includes its CI postinstall dependency closure without expanding the selected build", async () => {
  const f = await fixture(), directory = path.join(f.profile.workspaceRoot, "packages", "ci-scripts");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "package.json"),
    JSON.stringify({ name: "@1js/ci-scripts", scripts: { postinstall: "node ./bin/ci-scripts-postinstall.js" },
      dependencies: { "@1js/ado-tools": "*", "@1js/ado-logger": "*", "azure-devops-node-api": "^11.0.1",
        "@1js/arbitrary-one": "*" } }));
  fs.writeFileSync(path.join(f.profile.workspaceRoot, "package.json"),
    JSON.stringify({ scripts: { "build-scope": "yarn lage build --to" } }));
  const result = await setupRepository(f.profile, { packages: ["@1js/arbitrary-one"] }, "setup",
    { openCheckout: async () => f.checkout, execute: f.run });
  expect(result.packages).toEqual(["@1js/arbitrary-one"]);
  expect(f.commands.map(command => command.args)).toEqual([
    ["fast", "@1js/arbitrary-one", "@1js/ci-scripts", "@1js/ado-tools", "@1js/ado-logger"],
    ["patch-dependencies"], ["build-scope", "@1js/arbitrary-one"],
  ]);
});

test("warm setup builds upstream outputs through the stock selected dependency graph", async () => {
  const f = await fixture();
  fs.writeFileSync(path.join(f.profile.workspaceRoot, "package.json"),
    JSON.stringify({ scripts: { "build-scope": "yarn lage build --to" } }));
  let upstreamBuilt = false;
  const run = async (command, args, options) => {
    if (args[0] === "build-scope") upstreamBuilt = true;
    if (args[0] === "build" && !upstreamBuilt) throw new Error("Missing upstream declarations");
    return f.run(command, args, options);
  };
  const result = await setupRepository(f.profile, { packages: ["@1js/arbitrary-one"] }, "setup",
    { openCheckout: async () => f.checkout, execute: run });
  expect(result.buildWarmed).toBe(true);
  expect(f.commands.map(command => command.args)).toEqual([
    ["fast", "@1js/arbitrary-one"], ["patch-dependencies"], ["build-scope", "@1js/arbitrary-one"],
  ]);
  expect(f.commands.at(-1).cwd).toBe(f.profile.workspaceRoot);
  expect(f.commands.at(-1).env.BACKFILL_MODE).toBe(process.env.BACKFILL_MODE ?? "READ_WRITE");
  expect(f.commands.at(-1).env.BACKFILL_INTERNAL_CACHE_FOLDER).toBe(
    process.env.BACKFILL_INTERNAL_CACHE_FOLDER ?? process.env.MIDGARD_BACKFILL_CACHE_DIR ??
      path.join(f.profile.stateRoot, "build-cache"));
  expect(f.commands.at(-1).env.LAGE_WRITE_REMOTE_CACHE).toBe(process.env.LAGE_WRITE_REMOTE_CACHE ?? "false");
  expect(f.commands.slice(0, -1).every(command =>
    command.env.BACKFILL_MODE === process.env.BACKFILL_MODE &&
    command.env.BACKFILL_INTERNAL_CACHE_FOLDER === process.env.BACKFILL_INTERNAL_CACHE_FOLDER)).toBe(true);
  f.commands.length = 0;
  await setupRepository(f.profile, { packages: ["@1js/arbitrary-one"], runBuild: false }, "setup",
    { openCheckout: async () => f.checkout, execute: run });
  expect(f.commands.some(command => command.args[0] === "build-scope")).toBe(false);
  f.commands.length = 0;
  await setupRepository(f.profile, { packages: ["@1js/arbitrary-two"] }, "setup",
    { openCheckout: async () => f.checkout, execute: run });
  expect(f.commands.at(-1).args).toEqual(["build"]);
  expect(f.commands.at(-1).cwd).toBe(path.join(f.root, f.second));
  expect(f.commands.at(-1).env.BACKFILL_MODE).toBe(process.env.BACKFILL_MODE);
});

test("scoped build cache preserves explicit caller policy without changing the process environment", async () => {
  const f = await fixture(), keys = ["BACKFILL_MODE", "BACKFILL_INTERNAL_CACHE_FOLDER"];
  const inherited = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const cache = path.join(f.profile.stateRoot, "caller-cache");
  try {
    process.env.BACKFILL_MODE = "PASS";
    process.env.BACKFILL_INTERNAL_CACHE_FOLDER = cache;
    fs.writeFileSync(path.join(f.profile.workspaceRoot, "package.json"),
      JSON.stringify({ scripts: { "build-scope": "yarn lage build --to" } }));
    await setupRepository(f.profile, { packages: ["@1js/arbitrary-one"] }, "setup",
      { openCheckout: async () => f.checkout, execute: f.run });
    expect(f.commands.at(-1).env.BACKFILL_MODE).toBe("PASS");
    expect(f.commands.at(-1).env.BACKFILL_INTERNAL_CACHE_FOLDER).toBe(cache);
    expect(process.env.BACKFILL_MODE).toBe("PASS");
    expect(process.env.BACKFILL_INTERNAL_CACHE_FOLDER).toBe(cache);
  } finally {
    for (const key of keys) {
      if (inherited[key] === undefined) delete process.env[key];
      else process.env[key] = inherited[key];
    }
  }
});

test("scoped provisioning avoids repository-wide postinstall lint without disabling package checks", async () => {
  const f = await fixture(), inherited = process.env.MIDGARD_SKIP_ROOT_LINT;
  const run = async (command, args, options) => {
    if (args[0] === "fast" && options.env.MIDGARD_SKIP_ROOT_LINT !== "1")
      throw new Error("Repo-wide lint cannot validate sparse placeholder packages");
    return f.run(command, args, options);
  };
  await setupRepository(f.profile, { packages: ["@1js/arbitrary-two"] }, "setup",
    { openCheckout: async () => f.checkout, execute: run });
  expect(f.commands[0].env.MIDGARD_SKIP_ROOT_LINT).toBe("1");
  expect(f.commands.slice(1).every(command => command.env.MIDGARD_SKIP_ROOT_LINT === inherited)).toBe(true);
  expect(f.commands.map(command => command.args)).toEqual([
    ["fast", "@1js/arbitrary-two"], ["patch-dependencies"], ["build"],
  ]);
  await f.adapter.call("check", { repoRoot: f.root, packages: ["@1js/arbitrary-two"] });
  expect(f.commands.slice(3).map(command => command.args[0])).toEqual(["build", "bundle", "lint", "typecheck", "test"]);
  expect(f.commands.slice(3).every(command => command.env.MIDGARD_SKIP_ROOT_LINT === inherited)).toBe(true);
  expect(process.env.MIDGARD_SKIP_ROOT_LINT).toBe(inherited);
});

test("scoped installation runs the repository's stock dependency patches even when warm builds are disabled", async () => {
  const f = await fixture();
  const result = await setupRepository(f.profile, { packages: ["@1js/arbitrary-two"], runBuild: false }, "setup",
    { openCheckout: async () => f.checkout, execute: f.run });
  expect(result.steps.map(step => step.name)).toEqual(["scoped-install", "dependency-patches"]);
  expect(f.commands.map(({ args, cwd }) => ({ args, cwd }))).toEqual([
    { args: ["fast", "@1js/arbitrary-two"], cwd: path.join(f.root, "midgard") },
    { args: ["patch-dependencies"], cwd: path.join(f.root, "midgard") },
  ]);
});

test("a failed stock dependency patch cannot report successful setup or continue to build", async () => {
  const f = await fixture();
  f.fail("patch-dependencies");
  await expect(setupRepository(f.profile, { packages: ["@1js/arbitrary-two"] }, "setup",
    { openCheckout: async () => f.checkout, execute: f.run })).rejects.toThrow("Required patch-dependencies failed");
  expect(f.commands.map(command => command.args)).toEqual([["fast", "@1js/arbitrary-two"], ["patch-dependencies"]]);
});

test("scoped setup materializes explicitly selected sparse source through the existing prepare operation", async () => {
  const f = await fixture();
  f.git("sparse-checkout", "init", "--cone");
  f.git("sparse-checkout", "set", f.first);
  expect(fs.existsSync(path.join(f.root, f.second, "package.json"))).toBe(false);
  const result = await setupRepository(f.profile, { packages: ["@1js/arbitrary-two"], runBuild: false }, "setup",
    { openCheckout: async () => f.checkout, execute: f.run });
  expect(result.packages).toEqual(["@1js/arbitrary-two"]);
  expect(fs.existsSync(path.join(f.root, f.second, "package.json"))).toBe(true);
  expect(f.git("status", "--porcelain")).toBe("");
  expect(f.commands.map(({ args, cwd }) => ({ args, cwd }))).toEqual([
    { args: ["fast", "@1js/arbitrary-two"], cwd: path.join(f.root, "midgard") },
    { args: ["patch-dependencies"], cwd: path.join(f.root, "midgard") },
  ]);
});

test("scoped setup does not restore a user's deleted manifest inside a sparse checkout", async () => {
  const f = await fixture(), manifest = path.join(f.root, f.first, "package.json");
  f.git("sparse-checkout", "init", "--cone");
  f.git("sparse-checkout", "set", f.first);
  fs.unlinkSync(manifest);
  await expect(setupRepository(f.profile, { packages: ["@1js/arbitrary-one"], runBuild: false }, "setup",
    { openCheckout: async () => f.checkout, execute: f.run })).rejects.toThrow("existing checked-out");
  expect(fs.existsSync(manifest)).toBe(false);
  expect(f.commands).toHaveLength(0);
});

test("setup cannot report ready when stock installation prunes selected sparse source", async () => {
  const f = await fixture();
  f.git("sparse-checkout", "init", "--cone");
  f.git("sparse-checkout", "set", f.first);
  const run = async (command, args, options) => {
    const result = await f.run(command, args, options);
    if (args[0] === "fast") f.git("sparse-checkout", "set", f.first);
    return result;
  };
  await expect(setupRepository(f.profile, { packages: ["@1js/arbitrary-two"], runBuild: false }, "setup",
    { openCheckout: async () => f.checkout, execute: run })).rejects.toThrow("existing checked-out");
  expect(fs.existsSync(path.join(f.root, f.second, "package.json"))).toBe(false);
  expect(f.git("status", "--porcelain")).toBe("");
  expect(f.commands.map(command => command.args)).toEqual([["fast", "@1js/arbitrary-two"]]);
});

test("stock scoper retains new selections through installation without replacing existing scope entries", async () => {
  const f = await fixture();
  f.git("sparse-checkout", "init", "--cone");
  f.git("sparse-checkout", "set", f.first);
  const scopeFile = path.join(f.profile.workspaceRoot, ".scoper", "userScope.json");
  const original = { dependenciesUpToLevel: 2 };
  const scope = { focus: { "git-sparse-checkout": { packages: { "@1js/arbitrary-one": original } } } };
  fs.mkdirSync(path.dirname(scopeFile), { recursive: true });
  fs.writeFileSync(scopeFile, JSON.stringify(scope));
  fs.appendFileSync(path.join(f.root, ".git", "info", "exclude"), "\nmidgard/.scoper/\n");
  const run = async (command, args, options) => {
    const result = await f.run(command, args, options);
    if (args[0] === "scoper") {
      expect(args).toEqual(["scoper", "sparse-checkout", "add", "@1js/arbitrary-two", "--type", "package", "--quiet"]);
      const saved = JSON.parse(fs.readFileSync(scopeFile, "utf8"));
      saved.focus["git-sparse-checkout"].packages["@1js/arbitrary-two"] = {};
      fs.writeFileSync(scopeFile, JSON.stringify(saved));
    }
    if (args[0] === "fast") {
      const names = Object.keys(JSON.parse(fs.readFileSync(scopeFile, "utf8")).focus["git-sparse-checkout"].packages);
      f.git("sparse-checkout", "set", ...names.map(name => name === "@1js/arbitrary-one" ? f.first : f.second));
    }
    return result;
  };
  const result = await setupRepository(f.profile,
    { packages: ["@1js/arbitrary-one", "@1js/arbitrary-two"], runBuild: false }, "setup",
    { openCheckout: async () => f.checkout, execute: run });
  expect(result.steps.map(step => step.name)).toEqual(["sparse-package-selection", "scoped-install", "dependency-patches"]);
  expect(JSON.parse(fs.readFileSync(scopeFile, "utf8")).focus["git-sparse-checkout"].packages["@1js/arbitrary-one"])
    .toEqual(original);
  expect(fs.existsSync(path.join(f.root, f.first, "package.json"))).toBe(true);
  expect(fs.existsSync(path.join(f.root, f.second, "package.json"))).toBe(true);
  expect(f.git("status", "--porcelain")).toBe("");
});

test("an unmatched stock installer warning cannot produce successful setup", async () => {
  const f = await fixture();
  const run = async (command, args, options) => {
    await f.run(command, args, options);
    return { stdout: "We didn't find any packages that match @1js/arbitrary-two. This argument will be forwarded to yarn." };
  };
  await expect(setupRepository(f.profile, { packages: ["@1js/arbitrary-two"], runBuild: false }, "setup",
    { openCheckout: async () => f.checkout, execute: run })).rejects.toThrow("did not match");
  expect(f.commands.map(command => command.args)).toEqual([["fast", "@1js/arbitrary-two"]]);
});

test("an unrelated stale global-scope warning does not reject a successful requested installation", async () => {
  const f = await fixture();
  const run = async (command, args, options) => {
    await f.run(command, args, options);
    return { stdout: "We didn't find any packages that match @1js/removed-global-scope. This argument will be forwarded to yarn." };
  };
  const result = await setupRepository(f.profile, { packages: ["@1js/arbitrary-two"], runBuild: false }, "setup",
    { openCheckout: async () => f.checkout, execute: run });
  expect(result.ready).toBe(true);
  expect(result.packages).toEqual(["@1js/arbitrary-two"]);
  expect(f.commands.map(command => command.args)).toContainEqual(["fast", "@1js/arbitrary-two"]);
});

test("obsolete auxiliary CI scope metadata cannot reject successfully installed selected packages", async () => {
  const f = await fixture(), directory = path.join(f.profile.workspaceRoot, "packages", "ci-scripts");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({
    name: "@1js/ci-scripts", dependencies: { "@1js/removed-ci-scope": "*" },
  }));
  const run = async (command, args, options) => {
    await f.run(command, args, options);
    return { stdout: "We didn't find any packages that match @1js/removed-ci-scope. This argument will be forwarded to yarn." };
  };
  const result = await setupRepository(f.profile, { packages: ["@1js/arbitrary-two"], runBuild: false }, "setup",
    { openCheckout: async () => f.checkout, execute: run });
  expect(result.ready).toBe(true);
  expect(f.commands.map(command => command.args)).toEqual([
    ["fast", "@1js/arbitrary-two", "@1js/ci-scripts", "@1js/removed-ci-scope"], ["patch-dependencies"],
  ]);
});

test("setup cannot report ready or restore an ordinary manifest deleted during installation", async () => {
  const f = await fixture();
  const manifest = path.join(f.root, f.second, "package.json");
  const run = async (command, args, options) => {
    const result = await f.run(command, args, options);
    if (args[0] === "fast") fs.unlinkSync(manifest);
    return result;
  };
  await expect(setupRepository(f.profile, { packages: ["@1js/arbitrary-two"], runBuild: false }, "setup",
    { openCheckout: async () => f.checkout, execute: run })).rejects.toThrow("existing checked-out");
  expect(fs.existsSync(manifest)).toBe(false);
  expect(f.commands.map(command => command.args)).toEqual([["fast", "@1js/arbitrary-two"]]);
});

test("missing packages and root infrastructure never trigger a whole-repository build", async () => {
  const f = await fixture();
  await expect(f.adapter.call("build", { repoRoot: f.root, packages: ["@1js/missing"] })).rejects.toThrow("uniquely identify");
  await expect(selectedPackages(f.checkout, f.profile, {}, ["midgard/package.json"])).rejects.toThrow("explicit scoped packages");
  expect(f.commands).toHaveLength(0);
  for (const packages of [[], ["../outside"], ["@1js/a;run"], ["*"], ["@1js/a", null]])
    expect(() => validateRepositoryInput("check", { repoRoot: f.root, packages })).toThrow("packages");
});

test("the normal global PR path keeps shared formatting and cannot publish failed package checks", async () => {
  const f = await fixture(); f.commit();
  const input = { repoRoot: f.root, action: "create", sourceBranch: "user/test/topic", category: "fix",
    title: "Retain selected values", problem: "Selection lost the current value.",
    solution: "Selection now retains the current value.", validation: "The package checks passed.", uiChange: false, draft: true };
  f.fail("test");
  await expect(f.adapter.call("pr", input)).rejects.toThrow("Required test failed");
  expect(f.published()).toBeUndefined();
  expect(f.remote()).toBeUndefined();
  f.fail(undefined);
  const result = await f.adapter.call("pr", input);
  expect(result.structuredContent.pullRequestId).toBe(101);
  expect(f.published().description.match(/^# .+$/gm)).toEqual(Object.values(HEADINGS));
  expect(f.published().isDraft).toBe(true);
  expect(f.commands.every(command => command.cwd === path.join(f.root, f.second))).toBe(true);
});

test("live workspace ownership is never removed to admit another operation", async () => {
  const f = await fixture(), lock = path.join(f.root, ".git", "repository-mcp.lock");
  fs.writeFileSync(lock, "existing owner");
  await expect(withWorkspaceLock(path.join(f.root, ".git"), () => { throw new Error("must not run"); }))
    .rejects.toThrow("Workspace is locked");
  expect(fs.readFileSync(lock, "utf8")).toBe("existing owner");
});
