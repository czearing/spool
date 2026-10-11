import "./test-environment.ts";
import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installEnvironment, runInstallStep } from "./ci-install.mjs";
import { readInstallProgress, readLogTail, writeInstallProgress } from "./install-progress.mjs";

const roots: string[] = [];
afterAll(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });
function fixture(manager = "pnpm@11.27.0") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bohemia-restore-"));
  roots.push(root);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ packageManager: manager }));
  return { root, logs: path.join(root, "logs") };
}

test("Windows pnpm restores prefer hardlinks without changing the CI command or integrity policy", () => {
  const f = fixture();
  const step = { command: "pnpm install --frozen-lockfile", env: {} };
  const env = installEnvironment(f.root, step, {}, "win32");
  expect(env.pnpm_config_package_import_method).toBe("hardlink");
  expect(env.CI).toBe("true");
  expect(env.pnpm_config_verify_store_integrity).toBeUndefined();
  expect(env.pnpm_config_ignore_scripts).toBeUndefined();
  expect(env.pnpm_config_offline).toBeUndefined();
  expect(step.command).toBe("pnpm install --frozen-lockfile");
  expect(installEnvironment(f.root, step, {}, "linux").pnpm_config_package_import_method).toBeUndefined();
});

test("explicit environment and repository import policies are preserved", () => {
  const f = fixture(), step = { command: "pnpm install", env: {} };
  const env = installEnvironment(f.root, step, { PNPM_CONFIG_PACKAGE_IMPORT_METHOD: "copy" }, "win32");
  expect(env.PNPM_CONFIG_PACKAGE_IMPORT_METHOD).toBe("copy");
  expect(env.pnpm_config_package_import_method).toBeUndefined();
  const override = installEnvironment(f.root, { ...step, env: { PNPM_CONFIG_PACKAGE_IMPORT_METHOD: "clone" } },
    { pnpm_config_package_import_method: "copy" }, "win32");
  expect(override.PNPM_CONFIG_PACKAGE_IMPORT_METHOD).toBe("clone");
  expect(override.pnpm_config_package_import_method).toBeUndefined();
  fs.writeFileSync(path.join(f.root, "pnpm-workspace.yaml"), "packageImportMethod: copy\n");
  expect(installEnvironment(f.root, step, {}, "win32").pnpm_config_package_import_method).toBeUndefined();
  fs.writeFileSync(path.join(f.root, "pnpm-workspace.yaml"), "packageImportMethod: [");
  expect(() => installEnvironment(f.root, step, {}, "win32")).toThrow();
});

test("legacy pnpm, Yarn, and unknown package managers retain their install behavior", () => {
  for (const manager of ["pnpm@10.32.1", "yarn@4.9.0", "", "pnpm@invalid"]) {
    const f = fixture(manager);
    expect(installEnvironment(f.root, { env: {} }, {}, "win32").pnpm_config_package_import_method).toBeUndefined();
  }
});

test("install progress is available during the child, excludes raw output, and expires after completion", () => {
  const f = fixture();
  const started = Date.now();
  const result = runInstallStep(f.root, { command: "pnpm install --frozen-lockfile", env: {} }, {
    logDirectory: f.logs,
    spawn: (_command, args, options) => {
      expect(args).toEqual(["-lc", "pnpm install --frozen-lockfile"]);
      fs.writeSync(options.stdio[1], "private diagnostic\nProgress: resolved 123, reused 120, downloaded 3, added 99\n");
      const progress = readInstallProgress(f.root, started, f.logs);
      expect(progress?.counters).toEqual({ resolved: 123, reused: 120, downloaded: 3, added: 99 });
      expect(JSON.stringify(progress)).not.toContain("private diagnostic");
      expect(readInstallProgress(f.root, Date.now() + 1, f.logs)).toBeNull();
      return { status: 0 };
    },
  });
  expect(result.status).toBe(0);
  expect(result.output).toContain("Full CI install log:");
  expect(readInstallProgress(f.root, started, f.logs)).toBeNull();
});

test("real installs can emit more than the spawnSync buffer limit without truncating the durable log", () => {
  const f = fixture("yarn@4.9.0");
  const result = runInstallStep(f.root, {
    command: `node -e "process.stdout.write('x'.repeat(2*1024*1024));process.stderr.write('\\nfixture-tail\\n')"`, env: {},
  }, { logDirectory: f.logs });
  expect(result.status).toBe(0);
  expect(result.output).toContain("fixture-tail");
  expect(result.output.length).toBeLessThan(66 * 1024);
  const log = fs.readdirSync(f.logs).find(name => name.endsWith(".log"))!;
  expect(fs.statSync(path.join(f.logs, log)).size).toBeGreaterThan(2 * 1024 * 1024);
});

test("failed and throwing child processes clear running progress and retain the diagnostic", () => {
  for (const throws of [false, true]) {
    const f = fixture();
    const execute = () => runInstallStep(f.root, { command: "fixture", env: {} }, {
      logDirectory: f.logs,
      spawn: (_command, _args, options) => {
        fs.writeSync(options.stdio[2], "ERR_PNPM_FIXTURE: broken dependency\n");
        if (throws) throw new Error("fixture spawn failed");
        return { status: 23 };
      },
    });
    if (throws) expect(execute).toThrow("fixture spawn failed");
    else {
      const result = execute();
      expect(result.status).toBe(23);
      expect(result.output).toContain("ERR_PNPM_FIXTURE");
    }
    expect(readInstallProgress(f.root, 0, f.logs)).toBeNull();
  }
});

test("progress ignores previous calls and completed records but surfaces corruption", () => {
  const f = fixture();
  expect(readInstallProgress(f.root, 0, f.logs)).toBeNull();
  const log = path.join(f.logs, "fixture.log");
  writeInstallProgress(f.root, { state: "running", startedAt: 1, logFile: log }, f.logs);
  fs.writeFileSync(log, "Progress: reused nope, downloaded -1, added 4\n");
  expect(readInstallProgress(f.root, 2, f.logs)).toBeNull();
  expect(readInstallProgress(f.root, 0, f.logs)?.counters).toEqual({ added: 4 });
  expect(readLogTail(log, 7)).toBe("dded 4\n");
  const record = fs.readdirSync(f.logs).find(name => name.endsWith(".json"))!;
  fs.writeFileSync(path.join(f.logs, record), "{invalid");
  expect(() => readInstallProgress(f.root, 0, f.logs)).toThrow();
});
