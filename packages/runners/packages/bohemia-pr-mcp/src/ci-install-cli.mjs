import fs from "node:fs";
import path from "node:path";
import { installIsRecorded, runInstall } from "./ci-install.mjs";
import { repairYarnWorkspaceLinks } from "./yarn-link-recovery.mjs";
import { assertPreparationCapacity } from "./preparation-capacity.mjs";
import { installFailure } from "./install-diagnostics.mjs";

const root = process.argv[2];
if (!root || !path.isAbsolute(root)) throw new Error("An absolute checkout path is required");
const verify = process.argv[3] === "--verify";
const reuseOnly = process.argv[3] === "--reuse-only";
if (process.argv.length > 4 || (process.argv[3] && !verify && !reuseOnly)) {
  throw new Error("Usage: ci-install-cli.mjs <absolute checkout> [--verify|--reuse-only]");
}
const capacity = { creatorMinimumFreeGiB: process.env.BOHEMIA_MIN_FREE_GIB ? Number(process.env.BOHEMIA_MIN_FREE_GIB) : undefined };
assertPreparationCapacity(capacity, root);
function missingDependencies() {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const missing = [];
  for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
    const file = path.join(root, "node_modules", name, "package.json");
    if (!fs.existsSync(file)) { missing.push(name); continue; }
    const dependency = JSON.parse(fs.readFileSync(file, "utf8"));
    const bins = typeof dependency.bin === "string" ? { [name.split("/").at(-1)]: dependency.bin } : dependency.bin || {};
    for (const [bin, target] of Object.entries(bins)) {
      if (!fs.existsSync(path.resolve(path.dirname(file), target)) ||
          !["", ".cmd", ".exe"].some(suffix => fs.existsSync(path.join(root, "node_modules", ".bin", bin + suffix)))) missing.push(`${name} executable ${bin}`);
    }
  }
  return missing;
}
const linked = [".modules.yaml", ".yarn-state.yml"].some(name => fs.existsSync(path.join(root, "node_modules", name)));
const reusable = () => linked && installIsRecorded(root) && missingDependencies().length === 0;
if (reuseOnly) {
  // Legacy Yarn preparation can repair workspace links; leave that on the normal locked path.
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  if (manifest.packageManager?.startsWith("pnpm@") && reusable()) {
    console.log("Completed CI install matches the checkout lockfile; reusing dependencies.");
  } else {
    console.log("Dependencies require the normal preparation path.");
    process.exitCode = 2;
  }
} else {
  const recovered = repairYarnWorkspaceLinks(root);
  if (recovered.length) console.log(`Preserved ${recovered.length} stale workspace links before installation.`);
  if (!verify && reusable()) {
    console.log("Completed CI install matches the checkout lockfile; reusing dependencies.");
  } else {
    try {
      for (const step of runInstall(root, {
        beforeStep: () => assertPreparationCapacity(capacity, root),
        validate: () => {
          const missing = missingDependencies();
          if (missing.length) throw new Error(`CI installation left missing root dependencies: ${missing.join(", ")}`);
        },
      })) console.log(`${step.displayName}: exit ${step.status}`);
    } catch (error) { throw new Error(installFailure(error), { cause: error }); }
  }
}
