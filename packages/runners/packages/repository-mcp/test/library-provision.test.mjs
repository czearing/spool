import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { provisionLibraryCheckout } from "../src/adapters/library-provision.mjs";
import { libraryProfile, libraryEnvironment, LIBRARY_REMOTE } from "../src/adapters/library-profile.mjs";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "library-provision-"));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));
function fixture() {
  const root = fs.mkdtempSync(path.join(scratch, "case-"));
  const seed = path.join(root, "seed"), repo = path.join(root, "agent");
  fs.mkdirSync(seed);
  const git = (...args) => execFileSync("git", ["-C", seed, ...args], {
    encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  }).trim();
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  for (const relative of ["midgard/packages/m365-copilot-app-library/package.json", "unrelated/large.txt"]) {
    const file = path.join(seed, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, relative.endsWith("package.json") ? '{"name":"@1js/m365-copilot-app-library"}\n' : "not selected\n");
  }
  git("add", ".");
  git("-c", "core.hooksPath=" + path.join(root, "empty-hooks"), "commit", "-qm", "Fixture seed");
  git("remote", "add", "origin", LIBRARY_REMOTE);
  git("sparse-checkout", "set", "--no-cone", "midgard");
  fs.mkdirSync(path.join(seed, "midgard", ".scoper"), { recursive: true });
  fs.writeFileSync(path.join(seed, "midgard", ".scoper", "userScope.json"), '{"focus":{}}\n');
  fs.writeFileSync(path.join(seed, "midgard", ".scoper", "user.json"), '{"legacy":true}\n');
  const profile = libraryProfile({
    repoRoot: repo, storageRoot: root, toolchainRoot: repo, seedRoot: seed,
    nodeExecutable: process.execPath, baseBranch: "main",
  });
  return { root, seed, repo, git, profile, input: {
    repoRoot: repo, operation: "branch", seedRoot: seed, branch: "user/test/agent",
  }, dependencies: { authorize: async () => ({ environment: process.env, redactions: [] }) } };
}

test("provisioning creates an independent sparse repository, never a worktree or borrowed-object alternate", async () => {
  const f = fixture();
  await provisionLibraryCheckout(f.profile, f.input, f.dependencies);
  expect(fs.statSync(path.join(f.repo, ".git")).isDirectory()).toBe(true);
  expect(fs.existsSync(path.join(f.repo, ".git", "objects", "info", "alternates"))).toBe(false);
  expect(fs.existsSync(path.join(f.repo, "unrelated", "large.txt"))).toBe(false);
  expect(fs.existsSync(path.join(f.repo, "midgard", "packages", "m365-copilot-app-library", "package.json"))).toBe(true);
  expect(fs.readFileSync(path.join(f.repo, ".git", "info", "sparse-checkout"), "utf8"))
    .toBe(fs.readFileSync(path.join(f.seed, ".git", "info", "sparse-checkout"), "utf8"));
  const independent = execFileSync("git", ["-C", f.repo, "rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).trim();
  expect(fs.statSync(independent).ino).toBe(fs.statSync(path.join(f.repo, ".git")).ino);
  expect(fs.existsSync(path.join(f.repo, "midgard", ".store-linux"))).toBe(false);
  expect(fs.existsSync(path.join(f.repo, "midgard", ".scoper", "user.json"))).toBe(false);
  expect(libraryEnvironment(f.profile).MYS_GLOBAL_STORE).toBe(path.join(f.repo, "midgard",
    process.platform === "win32" ? ".store" : ".store-linux"));
  await provisionLibraryCheckout(f.profile, f.input, f.dependencies);
  expect(f.git("rev-parse", "HEAD")).toBe(execFileSync("git", ["-C", f.repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim());
});

test("unregistered seed and mutable shared toolchain cannot provision an agent", async () => {
  const f = fixture();
  await expect(provisionLibraryCheckout(f.profile, { ...f.input, seedRoot: f.root }, f.dependencies))
    .rejects.toThrow("registered seedRoot");
  await expect(provisionLibraryCheckout({ ...f.profile, toolchainRoot: f.seed }, f.input, f.dependencies))
    .rejects.toThrow("private toolchain");
  expect(fs.existsSync(f.repo)).toBe(false);
});

test("a seed without bounded sparse selection cannot accidentally expand the checkout", async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.seed, ".git", "info", "sparse-checkout"), "");
  await expect(provisionLibraryCheckout(f.profile, f.input, f.dependencies)).rejects.toThrow("bounded sparse");
  expect(fs.existsSync(f.repo)).toBe(false);
});
