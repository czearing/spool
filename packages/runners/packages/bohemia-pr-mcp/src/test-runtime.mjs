import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { loadYaml } from "./ci-install.mjs";

export function testRuntimePlans(root, names) {
  if (!path.isAbsolute(root) || !names.length) throw new Error("Test runtime preparation requires a checkout and explicit packages");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const workspace = path.join(root, "pnpm-workspace.yaml");
  const patterns = fs.existsSync(workspace) ? loadYaml(root).parse(fs.readFileSync(workspace, "utf8")).packages
    : Array.isArray(manifest.workspaces) ? manifest.workspaces : manifest.workspaces?.packages;
  if (!Array.isArray(patterns)) throw new Error("Cannot discover repository workspace packages");
  const wanted = new Set(names), found = new Set(), plans = [];
  for (const relative of fs.globSync(patterns.filter(pattern => !pattern.startsWith("!")), { cwd: root })) {
    if (patterns.some(pattern => pattern.startsWith("!") && path.matchesGlob(relative.replaceAll("\\", "/"), pattern.slice(1)))) continue;
    const directory = path.join(root, relative), file = path.join(directory, "package.json");
    if (!fs.existsSync(file)) continue;
    const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!wanted.has(pkg.name)) continue;
    if (found.has(pkg.name)) throw new Error(`Duplicate workspace package: ${pkg.name}`);
    found.add(pkg.name);
    const script = pkg.scripts?.test;
    if (typeof script !== "string") continue;
    // Reuse the checkout's declared setup, never invent a dependency list or run the test suite.
    const suffix = " && just-scripts test";
    if (!script.endsWith(suffix)) continue;
    const command = script.slice(0, -suffix.length).trim();
    if (!command) throw new Error(`Empty test setup for ${pkg.name}`);
    const config = ["jest.config.js", "jest.config.cjs"].find(name => fs.existsSync(path.join(directory, name)));
    if (!config) throw new Error(`Cannot verify the test configuration after setup for ${pkg.name}`);
    plans.push({ name: pkg.name, directory, command, config });
  }
  for (const name of wanted) if (!found.has(name)) throw new Error(`Workspace package not found: ${name}`);
  return plans;
}

export function prepareTestRuntimes(root, names, run = spawnSync) {
  const plans = testRuntimePlans(root, names);
  for (const plan of plans) {
    console.log(`Preparing declared test runtime: ${plan.name}`);
    const options = { cwd: plan.directory, encoding: "utf8", windowsHide: true, maxBuffer: 4 * 1024 * 1024 };
    const windows = process.platform === "win32";
    const setup = run(windows ? process.env.ComSpec || "cmd.exe" : "/bin/sh",
      windows ? ["/d", "/s", "/c", plan.command] : ["-c", plan.command], { ...options, stdio: "inherit" });
    if (setup.error || setup.status !== 0)
      throw new Error(`Test runtime setup failed for ${plan.name}: ${setup.error?.message || setup.stderr || `exit ${setup.status}`}`);
    const check = run("node", ["-e", "require(require('node:path').resolve(process.argv[1]))", plan.config], options);
    if (check.error || check.status !== 0)
      throw new Error(`Test configuration remains unavailable for ${plan.name}: ${check.error?.message || check.stderr || `exit ${check.status}`}`);
  }
  return plans.map(plan => plan.name);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  prepareTestRuntimes(path.resolve(process.argv[2]), (process.argv[3] || "").split(",").filter(Boolean));
}
