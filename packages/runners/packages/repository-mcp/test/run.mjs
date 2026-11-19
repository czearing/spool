import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const directory = import.meta.dirname;
const tests = fs.readdirSync(directory).filter(name => name.endsWith(".test.mjs")).sort();
const bunTests = tests.filter(name => /from\s+["']bun:test["']/.test(fs.readFileSync(path.join(directory, name), "utf8")));
const nodeTests = tests.filter(name => !bunTests.includes(name));
const bun = path.join(os.homedir(), ".bun", "bin", process.platform === "win32" ? "bun.exe" : "bun");
for (const [command, args] of [
  [fs.existsSync(bun) ? bun : "bun", ["test", "--timeout", "30000", ...bunTests]],
  [process.execPath, ["--test", "--test-concurrency=1", ...nodeTests]],
]) {
  const result = spawnSync(command, args, { cwd: directory, stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) { process.exitCode = result.status || 1; break; }
}
