import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { selectedPackages } from "./1js-packages.mjs";
import { validateDependencyPatchCache } from "./1js-patch-cache.mjs";
import { writeReceipt } from "../process.mjs";

const cacheFile = checkout => checkout.receiptPath("ready-preparation.json");
export function preparationImplementation() {
  const hash = createHash("sha256");
  const files = fs.readdirSync(new URL(".", import.meta.url)).filter(name => /^1js.*\.(?:mjs|cjs)$/.test(name)).sort();
  for (const name of [...files, "../../../bohemia-pr-mcp/src/operations.mjs",
    "../../../bohemia-pr-mcp/src/prepare-branch.mjs", "../../../bohemia-pr-mcp/src/preparation-process.mjs"])
    hash.update(name).update(fs.readFileSync(new URL(name, import.meta.url)));
  return hash.digest("hex");
}
const requestKey = input => JSON.stringify(Object.fromEntries(Object.entries({
  ...input, repoRoot: undefined, minimumFreeGiB: undefined,
  operation: input.operation || "branch", mode: input.mode || "checkout",
  baseBranch: input.baseBranch || "main", reset: input.reset === true,
  mergeMaster: input.mergeMaster === true, allowConflicts: input.allowConflicts === true,
  runSetup: input.runSetup !== false, runBuild: input.runBuild !== false,
  packages: input.packages && [...input.packages].sort(),
}).sort(([a], [b]) => a.localeCompare(b))));
const environmentKey = profile => createHash("sha256").update(JSON.stringify([
  profile, process.version, process.platform, process.arch, preparationImplementation(),
  Object.entries(process.env).filter(([key]) =>
    /^(NODE_ENV|NODE_OPTIONS|SKIP_DEPENDENCY_PATCHING|PREFERRED_WORKSPACE_MANAGER|MYS_|YARN_|LAGE_|BACKFILL_|MIDGARD_)/.test(key))
    .sort(([a], [b]) => a.localeCompare(b)),
])).digest("hex");
function stamp(file) {
  try {
    const stat = fs.statSync(file);
    return [fs.realpathSync(file), stat.size, stat.mtimeMs, stat.ino];
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
async function artifacts(checkout, profile, input) {
  const packages = await selectedPackages(checkout, profile, input), files = new Set(), visited = new Set();
  const outputDirectories = new Set();
  const collectOutput = directory => {
    files.add(directory);
    if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) return;
    const physical = fs.realpathSync(directory);
    if (outputDirectories.has(physical)) return;
    outputDirectories.add(physical);
    for (const entry of fs.readdirSync(directory)) collectOutput(path.join(directory, entry));
  };
  for (const name of ["package.json", "yarn.lock", ".yarnrc", ".yarnrc.yml", ".scoper/userScope.json",
    ".scoper/scopedScoperPackages.json",
    "node_modules", "node_modules/.yarn-integrity", ".yarn/install-state.gz"])
    files.add(path.join(profile.workspaceRoot, name));
  files.add(path.join(checkout.directory, "info", "sparse-checkout"));
  for (const file of (await checkout.git("ls-files", "-z", "--", ":(glob)**/package.json")).split("\0").filter(Boolean))
    files.add(path.join(profile.repoRoot, file));
  if (!fs.existsSync(path.join(profile.workspaceRoot, "node_modules"))) return null;
  const visit = (root, required = false) => {
    root = fs.realpathSync(root);
    const file = path.join(root, "package.json"), manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    files.add(file); files.add(path.join(root, "node_modules"));
    const outputs = [...new Set([manifest.main, manifest.module, manifest.types, manifest.typings]
      .filter(value => typeof value === "string" && !value.includes("*")).map(value => path.resolve(root, value)))];
    if (required && manifest.scripts?.build && (!outputs.length || outputs.some(output => !fs.existsSync(output))))
      throw Object.assign(new Error("Prepared package output is unavailable"), { code: "CACHE_OUTPUT_MISSING" });
    if (visited.has(root)) return;
    visited.add(root);
    outputs.forEach(output => files.add(output));
    for (const directory of ["lib", "dist"]) collectOutput(path.join(root, directory));
    const require = createRequire(file);
    for (const name of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies,
      ...(required ? manifest.devDependencies : {}) })) {
      let dependency;
      try { dependency = require.resolve(`${name}/package.json`); }
      catch (error) {
        if (error.code !== "MODULE_NOT_FOUND" && error.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
        const candidates = (require.resolve.paths(name) || []).map(directory => path.join(directory, name, "package.json"));
        for (const candidate of candidates) {
          files.add(candidate); files.add(path.dirname(candidate));
        }
        dependency = candidates.find(candidate => fs.existsSync(candidate));
        if (!dependency) continue;
      }
      files.add(dependency);
      if (name.startsWith("@1js/")) visit(path.dirname(dependency));
    }
  };
  try { packages.forEach(pkg => visit(pkg.root, true)); }
  catch (error) { if (error.code === "CACHE_OUTPUT_MISSING") return null; throw error; }
  return [...files].sort().map(file => [file, stamp(file)]);
}

export async function reuseReadyPreparation(checkout, profile, input) {
  if (input.operation === "master" || !input.packages?.length) return null;
  let saved;
  try { saved = JSON.parse(fs.readFileSync(cacheFile(checkout), "utf8")); }
  catch (error) { if (error.code === "ENOENT" || error instanceof SyntaxError) return null; throw error; }
  if (saved.version !== 1 || saved.environment !== environmentKey(profile) ||
      JSON.stringify([...input.packages].sort()) !== saved.packages ||
      input.operation !== "setup" && saved.request !== requestKey(input) ||
      !saved.result?.ready || saved.result.buildWarmed !== true || saved.result.merge?.conflicted ||
      !Array.isArray(saved.artifacts) || !Array.isArray(saved.selected)) return null;
  if (await checkout.head() !== saved.result.commit || await checkout.branch() !== saved.result.branch ||
      ["MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD", "sequencer",
        "bohemia-workspace.lock"].some(name => fs.existsSync(path.join(checkout.directory, name))) ||
      await checkout.git("status", "--porcelain=v1", "--untracked-files=all")) return null;
  const space = fs.statfsSync(profile.repoRoot);
  if (space.bavail * space.bsize < (input.minimumFreeGiB || 0) * 1024 ** 3) return null;
  for (const [file, previous] of saved.artifacts)
    if (JSON.stringify(stamp(file)) !== JSON.stringify(previous)) return null;
  try { validateDependencyPatchCache(profile, saved.selected, process.env); }
  catch (error) { if (error.staleMarkers) return null; throw error; }
  if ((input.operation || "branch") === "branch") {
    const refs = [`refs/heads/${saved.result.branch}`, `refs/heads/${profile.baseBranch}`];
    const remote = await checkout.networkGit("ls-remote", "--heads", "origin", ...refs);
    const heads = new Map(remote.split(/\r?\n/).filter(Boolean).map(line => line.split(/\s+/).reverse()));
    if (input.expectedHead && heads.get(refs[0])?.toLowerCase() !== input.expectedHead.toLowerCase()) return null;
    if (JSON.stringify(refs.map(ref => heads.get(ref) || null)) !== saved.upstreams) return null;
  }
  if (await checkout.head() !== saved.result.commit ||
      await checkout.git("status", "--porcelain=v1", "--untracked-files=all")) return null;
  return { ...saved.result, cached: true, cacheVerifiedAt: new Date().toISOString() };
}

export function invalidateReadyPreparation(checkout) {
  fs.rmSync(cacheFile(checkout), { force: true });
}

export async function rememberReadyPreparation(checkout, profile, input, result) {
  invalidateReadyPreparation(checkout);
  if (!result.ready || result.buildWarmed !== true || result.merge?.conflicted ||
      input.runSetup === false || !input.packages?.length ||
      await checkout.git("status", "--porcelain=v1", "--untracked-files=all")) return;
  const outputs = await artifacts(checkout, profile, input);
  if (!outputs) return;
  const refs = [result.branch, profile.baseBranch].map(branch => `refs/remotes/origin/${branch}`);
  const tracked = await checkout.git("for-each-ref", "--format=%(objectname) %(refname)", ...refs);
  const heads = new Map(tracked.split(/\r?\n/).filter(Boolean).map(line => line.split(/\s+/).reverse()));
  writeReceipt(cacheFile(checkout), { version: 1, environment: environmentKey(profile), request: requestKey(input),
    packages: JSON.stringify([...input.packages].sort()), artifacts: outputs, result,
    selected: (await selectedPackages(checkout, profile, input)).map(({ name, root }) => ({ name, root })),
    upstreams: JSON.stringify(refs.map(ref => heads.get(ref) || null)) });
}
