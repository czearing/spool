import "./test-environment.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide } from "./bypass-guard";

const root = mkdtempSync(join(tmpdir(), "push-scope-"));
const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
const allowed = (command: string, cwd = root) => !decide("powershell", { command }, cwd).deny;
const spool = "https://github.com/example/spool.git";
const bohemia = "https://dev.azure.com/example/Project/_git/Office-Bohemia";
beforeAll(() => {
  git("init", "--quiet");
  git("remote", "add", "origin", spool);
  git("remote", "add", "office", bohemia);
  git("remote", "add", "ssh-office", "git@ssh.dev.azure.com:v3/example/Project/office-bohemia");
  git("remote", "add", "mixed", spool);
  git("remote", "set-url", "--add", "--push", "mixed", spool);
  git("remote", "set-url", "--add", "--push", "mixed", bohemia);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
test("allows other repositories, including a bare push using the default remote", () => {
  expect(allowed("git push origin HEAD:master")).toBe(true);
  expect(allowed("git push --tags")).toBe(true);
});
test("blocks Office Bohemia by destination, not folder or remote name", () => {
  expect(allowed("git push office HEAD")).toBe(false);
  expect(allowed("git push ssh-office HEAD")).toBe(false);
  expect(allowed("git push mixed HEAD")).toBe(false);
  expect(allowed("git push --repo=office HEAD")).toBe(false);
  expect(allowed("git push --repo=origin HEAD")).toBe(true);
  expect(allowed(`git push "${bohemia}" HEAD`)).toBe(false);
  expect(allowed(`git push "${spool}" HEAD`)).toBe(true);
});
test("honors explicit working directories and compound directory changes", () => {
  expect(allowed(`git -C "${root}" push origin HEAD`, tmpdir())).toBe(true);
  expect(allowed(`Set-Location -LiteralPath "${root}"; git push origin HEAD`, tmpdir())).toBe(true);
  expect(allowed(`cd "${root}" && git push office HEAD`, tmpdir())).toBe(false);
  expect(allowed("git push origin HEAD; git push office HEAD")).toBe(false);
});
test("honors push URLs, push defaults, and Git URL rewrites", () => {
  git("config", "remote.pushDefault", "office");
  expect(allowed("git push")).toBe(false);
  git("config", "--unset", "remote.pushDefault");
  git("config", "remote.origin.pushurl", bohemia);
  expect(allowed("git push origin HEAD")).toBe(false);
  git("config", "--unset", "remote.origin.pushurl");
  git("config", `url.${bohemia}.pushInsteadOf`, spool);
  expect(allowed("git push origin HEAD")).toBe(false);
  expect(allowed(`git push "${spool}" HEAD`)).toBe(false);
  git("config", "--unset", `url.${bohemia}.pushInsteadOf`);
});
test("does not reinterpret unresolved shell expressions as another repository", () => {
  expect(allowed("git push $destination HEAD")).toBe(false);
  expect(allowed("Set-Location $repository; git push origin HEAD")).toBe(false);
  expect(allowed("git -c remote.origin.pushurl=unknown push origin HEAD")).toBe(false);
});
test("does not affect reads or the approved Bohemia publishing path", () => {
  expect(allowed("git status; git remote -v")).toBe(true);
  expect(allowed("bohemia push")).toBe(true);
});
