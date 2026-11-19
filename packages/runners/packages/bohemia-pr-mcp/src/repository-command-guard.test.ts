import "./test-environment.ts";
import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { libraryShellOperation, registeredLibrary } from "./repository-command-guard.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "repository-command-guard-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const profile = {
  repoRoot: "C:\\agents\\library",
  wsl: { distribution: "library-test", repoRoot: "/home/dev/library" },
};
const config = path.join(root, "registry.json");
fs.writeFileSync(config, JSON.stringify({ version: 1, library: profile }));
const denies = (command: string, cwd = profile.repoRoot) => libraryShellOperation(command, cwd, profile);

test.each([
  "yarn build", "yarn workspace @1js/m365-copilot-app-library build",
  "yarn fast @1js/m365-copilot-app-library", "npm test", "npx jest",
  "pnpm install", "bun run build", "corepack yarn build", "rsbuild dev",
  "yarn start:dev",
  "wsl -d library-test --cd /home/dev/library/midgard/packages/m365-copilot-app-library --exec yarn start:dev",
  "midgard-scripts typecheck", "tsgo --noEmit", "jest --runInBand",
  "node packages/midgard-yarn/v1.23.33.js build",
  "node ./scripts/build.js", "git push origin HEAD",
  'bash -lc "yarn build"', 'powershell -Command "npm test"',
  "env CI=true yarn lint",
  `& 'C:\\tools\\yarn.cmd' build`,
  `node -e "require('node:child_process').execFileSync('yarn',['build'])"`,
])("denies direct registered-workspace operation: %s", command => {
  expect(denies(command)).toBe(true);
});

test("detects explicit and nested Windows, UNC and native working directories", () => {
  expect(denies('cd C:\\agents\\library; yarn build', root)).toBe(true);
  expect(denies('yarn --cwd C:\\agents\\library build', root)).toBe(true);
  expect(denies('yarn --cwd=C:\\agents\\library build', root)).toBe(true);
  expect(denies('npm --prefix=C:\\agents\\library run build', root)).toBe(true);
  expect(denies("yarn build", "\\\\wsl.localhost\\library-test\\home\\dev\\library")).toBe(true);
  expect(denies("yarn build", "\\\\?\\UNC\\wsl.localhost\\library-test\\home\\dev\\library")).toBe(true);
  expect(denies("yarn build", "/home/dev/library/midgard")).toBe(true);
  expect(denies('wsl.exe -d library-test --exec bash -lc "yarn build"', root)).toBe(true);
  expect(denies("wsl.exe -d library-test --exec env CI=true yarn build", root)).toBe(true);
  expect(denies("wsl.exe --distribution=library-test --exec yarn build", root)).toBe(true);
  expect(denies("wsl.exe --cd=/home/dev/library --exec yarn build", root)).toBe(true);
  expect(denies('wsl --cd /home/dev/library --exec yarn build', root)).toBe(true);
  const encoded = Buffer.from("yarn build", "utf16le").toString("base64");
  expect(denies(`pwsh -EncodedCommand ${encoded}`)).toBe(true);
});

test("does not block source inspection or unrelated repositories", () => {
  for (const command of ["git status", "git diff", "git commit -m Fix", "node --version",
    "Get-Content package.json", "rg build package.json"]) expect(denies(command)).toBe(false);
  expect(denies("yarn build", root)).toBe(false);
  expect(denies("yarn build", "C:\\agents\\library-other")).toBe(false);
  expect(denies('cd C:\\other; yarn build')).toBe(false);
  expect(libraryShellOperation("yarn build", root)).toBe(false);
});

test("registration is external, dynamic, and rejects malformed configuration", () => {
  expect(registeredLibrary({ REPOSITORY_MCP_CONFIG: config })).toEqual(profile);
  const invalid = path.join(root, "invalid.json");
  fs.writeFileSync(invalid, '{"library":{"repoRoot":false}}');
  expect(() => registeredLibrary({ REPOSITORY_MCP_CONFIG: invalid })).toThrow("Invalid");
});

function hook(event: unknown) {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./bypass-guard.ts", import.meta.url))], {
    input: JSON.stringify(event), encoding: "utf8", windowsHide: true,
    env: { ...process.env, REPOSITORY_MCP_CONFIG: config },
  });
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout.trim());
}

test("the installed hook entry denies direct tools and permits approved MCP calls", () => {
  expect(hook({ toolName: "functions.powershell", toolArgs: { command: "yarn build" },
    cwd: profile.repoRoot }).permissionDecision).toBe("deny");
  expect(hook({ toolName: "multi_tool_use.parallel", toolArgs: { tool_uses: [
    { recipient_name: "functions.powershell", parameters: { command: "yarn test" } },
  ] }, cwd: profile.repoRoot }).permissionDecision).toBe("deny");
  expect(hook({ toolCalls: [
    { name: "view", args: { path: "package.json" } },
    { name: "powershell", args: JSON.stringify({ command: "yarn build" }) },
  ], cwd: profile.repoRoot }).permissionDecision).toBe("deny");
  for (const name of ["repo_prepare", "repo_build", "repo_check", "repo_pr", "repo_add_packages", "repo_start"]) {
    expect(hook({ toolName: `repository-${name}`, toolArgs: { repo: "1js", input: {
      repoRoot: profile.repoRoot,
    } }, cwd: profile.repoRoot })).toEqual({});
  }
});
