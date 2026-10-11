import "./test-environment.ts";
import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { installSteps, runInstall, runInstallStep, installIsRecorded, recordInstall } from "./ci-install.mjs";

const roots: string[] = [];
afterAll(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });
function fixture(manager = "pnpm") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bohemia-ci-install-"));
  roots.push(root);
  const template = path.join(root, "azure", "build-pipelines", "templates", "install-deps.yaml");
  fs.mkdirSync(path.dirname(template), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ packageManager: `${manager}@1.0.0` }));
  const lock = path.join(root, manager === "yarn" ? "yarn.lock" : "pnpm-lock.yaml");
  fs.writeFileSync(lock, "first lock\n");
  return { root, template, lock };
}

test("the shared installer follows each checkout's Yarn or pnpm CI command", () => {
  for (const manager of ["yarn", "pnpm"]) {
    const f = fixture(manager);
    const command = manager === "yarn" ? "yarn install --immutable" : "pnpm install --frozen-lockfile";
    fs.writeFileSync(f.template, `steps:\n  - bash: ${command}\n    displayName: Install dependencies\n`);
    expect(installSteps(f.root).map(step => step.command)).toEqual([command]);
    const commands: string[] = [];
    runInstall(f.root, { run: (_root, step) => { commands.push(step.command); return { status: 0 }; } });
    expect(commands).toEqual([command]);
    expect(installIsRecorded(f.root)).toBe(true);
  }
});

test("install cache uses lockfile content, never checkout timestamps", () => {
  const f = fixture();
  expect(installIsRecorded(f.root)).toBe(false);
  recordInstall(f.root);
  fs.utimesSync(f.lock, new Date(), new Date());
  expect(installIsRecorded(f.root)).toBe(true);
  fs.writeFileSync(f.lock, "different lock\n");
  expect(installIsRecorded(f.root)).toBe(false);
});

test("explicit CI verification runs even when dependencies have a completed install stamp", () => {
  const f = fixture();
  fs.writeFileSync(f.template, "steps:\n  - bash: node -e \"require('fs').writeFileSync('verified.txt','yes')\"\n");
  recordInstall(f.root);
  fs.writeFileSync(path.join(f.root, "node_modules", ".modules.yaml"), "");
  const cli = fileURLToPath(new URL("./ci-install-cli.mjs", import.meta.url));
  const options = { encoding: "utf8" as const, timeout: 30000,
    env: { ...process.env, BOHEMIA_MIN_FREE_GIB: "0.001" } };
  const cached = spawnSync("node", [cli, f.root], options);
  expect(cached.status).toBe(0);
  expect(fs.existsSync(path.join(f.root, "verified.txt"))).toBe(false);
  const checked = spawnSync("node", [cli, f.root, "--verify"], options);
  expect(checked.stderr).toBe("");
  expect(checked.status).toBe(0);
  expect(fs.readFileSync(path.join(f.root, "verified.txt"), "utf8")).toBe("yes");
});

test("failed CI installation neither executes later steps nor records success", () => {
  const f = fixture();
  fs.writeFileSync(f.template, "steps:\n  - bash: first\n  - bash: failing\n  - bash: never\n");
  const commands: string[] = [];
  expect(() => runInstall(f.root, { run: (_root, step) => {
    commands.push(step.command);
    return { status: step.command === "failing" ? 1 : 0, output: "fixture failure" };
  } })).toThrow("fixture failure");
  expect(commands).toEqual(["first", "failing"]);
  expect(installIsRecorded(f.root)).toBe(false);
});

test("a failed reinstall invalidates its previous success receipt before any work starts", () => {
  const f = fixture();
  recordInstall(f.root);
  expect(() => runInstall(f.root, {
    steps: [{ command: "fixture", displayName: "fixture", env: {} }],
    beforeStep: () => {
      expect(installIsRecorded(f.root)).toBe(false);
      throw new Error("Interrupted before installation");
    },
  })).toThrow("Interrupted before installation");
  expect(installIsRecorded(f.root)).toBe(false);
  recordInstall(f.root);
  expect(() => runInstall(f.root, {
    steps: [{ command: "fixture", displayName: "fixture", env: {} }],
    run: () => ({ status: 1, output: "failed reinstall" }),
  })).toThrow("failed reinstall");
  expect(installIsRecorded(f.root)).toBe(false);
});

test("reuse-only checks are read-only and require complete, current pnpm dependencies", () => {
  const f = fixture();
  fs.writeFileSync(f.template, "steps:\n  - bash: node -e \"require('fs').writeFileSync('installed.txt','yes')\"\n");
  const cli = fileURLToPath(new URL("./ci-install-cli.mjs", import.meta.url));
  const probe = () => spawnSync("node", [cli, f.root, "--reuse-only"], {
    encoding: "utf8", timeout: 30000,
    env: { ...process.env, BOHEMIA_MIN_FREE_GIB: "0.001" },
  });
  expect(probe().status).toBe(2);
  expect(fs.existsSync(path.join(f.root, "node_modules"))).toBe(false);
  recordInstall(f.root);
  expect(probe().status).toBe(2);
  const linked = path.join(f.root, "node_modules", ".modules.yaml");
  fs.writeFileSync(linked, "");
  expect(probe().status).toBe(0);
  const stamp = fs.readFileSync(path.join(f.root, "node_modules", ".ci-install.json"), "utf8");
  fs.writeFileSync(f.lock, "changed lock");
  expect(probe().status).toBe(2);
  expect(fs.readFileSync(path.join(f.root, "node_modules", ".ci-install.json"), "utf8")).toBe(stamp);
  recordInstall(f.root);
  fs.writeFileSync(path.join(f.root, "package.json"), JSON.stringify({
    packageManager: "pnpm@1.0.0", dependencies: { fixture: "1.0.0" },
  }));
  expect(probe().status).toBe(2);
  const dependency = path.join(f.root, "node_modules", "fixture");
  fs.mkdirSync(dependency);
  fs.writeFileSync(path.join(dependency, "package.json"), JSON.stringify({ bin: "cli.js" }));
  expect(probe().status).toBe(2);
  fs.mkdirSync(path.join(f.root, "node_modules", ".bin"));
  fs.writeFileSync(path.join(f.root, "node_modules", ".bin", "fixture.cmd"), "");
  expect(probe().status).toBe(2);
  fs.writeFileSync(path.join(dependency, "cli.js"), "process.exit(0);\n");
  expect(probe().status).toBe(0);
  fs.writeFileSync(path.join(dependency, "package.json"), "invalid json");
  const invalid = probe();
  expect(invalid.status).not.toBe(0);
  expect(invalid.status).not.toBe(2);
  expect(invalid.stderr).toContain("SyntaxError");
  expect(fs.existsSync(path.join(f.root, "installed.txt"))).toBe(false);
});

test("a successful command with incomplete root dependencies cannot stamp the install", () => {
  const f = fixture();
  fs.writeFileSync(f.template, "steps:\n  - bash: node -e \"process.exit(0)\"\n");
  fs.writeFileSync(path.join(f.root, "package.json"), JSON.stringify({
    packageManager: "pnpm@1.0.0", dependencies: { missing: "1.0.0" },
  }));
  recordInstall(f.root);
  const result = spawnSync("node", [fileURLToPath(new URL("./ci-install-cli.mjs", import.meta.url)), f.root, "--verify"], {
    encoding: "utf8", timeout: 30000, windowsHide: true,
    env: { ...process.env, BOHEMIA_MIN_FREE_GIB: "0.001" },
  });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("missing root dependencies: missing");
  expect(installIsRecorded(f.root)).toBe(false);
});

test("reuse-only leaves legacy Yarn link recovery to normal preparation", () => {
  const f = fixture("yarn");
  recordInstall(f.root);
  fs.writeFileSync(path.join(f.root, "node_modules", ".yarn-state.yml"), "");
  fs.writeFileSync(path.join(f.root, "package.json"), JSON.stringify({
    packageManager: "yarn@1.0.0", workspaces: ["packages/*"],
  }));
  const bin = path.join(f.root, "packages", "fixture", "node_modules", ".bin");
  fs.mkdirSync(bin, { recursive: true });
  const shim = path.join(bin, "fixture.cmd");
  fs.writeFileSync(shim, "stale .pnpm link");
  const cli = fileURLToPath(new URL("./ci-install-cli.mjs", import.meta.url));
  const options = { encoding: "utf8" as const, timeout: 30000,
    env: { ...process.env, BOHEMIA_MIN_FREE_GIB: "0.001" } };
  expect(spawnSync("node", [cli, f.root, "--reuse-only"], options).status).toBe(2);
  expect(fs.readFileSync(shim, "utf8")).toBe("stale .pnpm link");
  const normal = spawnSync("node", [cli, f.root], options);
  expect(normal.status).toBe(0);
  expect(normal.stdout).toContain("Preserved 1 stale workspace links");
  expect(fs.existsSync(shim)).toBe(false);
});

test("install process failures lead the diagnostic instead of being buried in progress output", () => {
  const f = fixture(), output = "Progress: resolving dependencies\n".repeat(100);
  const result = runInstallStep(f.root, { command: "unused", env: {} }, {
    spawn: () => ({ status: null, error: Object.assign(new Error("spawnSync ETIMEDOUT"), { code: "ETIMEDOUT" }),
      stdout: output, stderr: "" }),
  });
  expect(result.status).not.toBe(0);
  expect(result.output.startsWith("Error: CI install process timed out (ETIMEDOUT)")).toBe(true);
  expect(result.output).toContain(output.trim());
});

test("CI Node options take precedence and inherited runtime options are preserved", () => {
  const f = fixture();
  for (const [stepOptions, inherited, expected] of [
    [undefined, undefined, "--max-old-space-size=16384"],
    [undefined, "--diagnostic-dir=fixture", "--diagnostic-dir=fixture"],
    ["--max-old-space-size=8192", "--diagnostic-dir=fixture", "--max-old-space-size=8192"],
  ]) {
    runInstallStep(f.root, { command: "unused", env: stepOptions ? { NODE_OPTIONS: stepOptions } : {} }, {
      environment: inherited ? { NODE_OPTIONS: inherited } : {},
      spawn: (_command, _args, options) => {
        expect(options.env.NODE_OPTIONS).toBe(expected);
        expect(options.timeout).toBeUndefined();
        return { status: 0, stdout: "", stderr: "" };
      },
    });
  }
});
