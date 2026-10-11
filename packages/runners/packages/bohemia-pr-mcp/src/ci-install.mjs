/**
 * Shared Bohemia dependency installation, derived from the checkout's own CI definition.
 *
 * The analysis worktree only produces trustworthy numbers when it is prepared the same way
 * the build that produced the bundle artifact was prepared. Hardcoding "run yarn install"
 * here would silently drift the day CI adds, reorders or replaces a step, and the tool would
 * keep reporting confident numbers from a differently prepared tree. So the steps are read
 * out of azure/build-pipelines at the pinned commit and executed in the order CI lists them.
 *
 * Only plain shell steps are taken. Everything CI does that is meaningless locally, such as
 * 1ES publishing, telemetry, artifact upload and AzureCLI tasks, is skipped by construction:
 * a step is eligible only when it is a `bash` or `script` step inside one of the install
 * templates that the pipeline actually references.
 *
 * No regular expressions are used anywhere in this package.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { installLogDirectory, readLogTail, writeInstallProgress } from "./install-progress.mjs";

const TEMPLATE_DIR = path.join("azure", "build-pipelines", "templates");

/**
 * Load a YAML parser.
 *
 * The repo's own copy is preferred so no new dependency is introduced and the parser matches
 * what the pipeline itself is read with. But this runs on a clone that may have no
 * node_modules at all, since deriving the install steps is precisely what happens *before*
 * the first install: resolving only from the repo would deadlock on a fresh clone. So the
 * tool carries its own copy as a fallback, and one of the two must be present.
 */
export function loadYaml(repoRoot) {
  const fromRepo = createRequire(path.join(repoRoot, "package.json"));
  try {
    return fromRepo("yaml");
  } catch {
    // The clone is not installed yet; fall back to the parser vendored with this tool.
  }
  const fromTool = createRequire(import.meta.url);
  try {
    return fromTool("yaml");
  } catch {
    throw new Error(
      `No YAML parser available. The clone at ${repoRoot} has no node_modules yet and this tool has no ` +
        `vendored copy. Run "yarn install" in ${path.dirname(new URL(import.meta.url).pathname)}/.. to fix.`
    );
  }
}

/**
 * Resolve a pipeline template reference to a path inside the repo.
 *
 * Azure DevOps writes these as `/azure/build-pipelines/templates/x.yaml@self` or as a
 * relative `./x.yaml`. Both forms appear in this repo, and the `@self` suffix names the
 * repository resource rather than part of the path, so it is trimmed.
 */
export function resolveTemplateReference(reference, repoRoot) {
  if (typeof reference !== "string" || reference.length === 0) return null;
  const atIndex = reference.lastIndexOf("@");
  const withoutResource = atIndex === -1 ? reference : reference.slice(0, atIndex);
  const trimmed = withoutResource.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith("./")) return path.join(repoRoot, TEMPLATE_DIR, trimmed.slice(2));
  if (trimmed.startsWith("/")) return path.join(repoRoot, ...trimmed.slice(1).split("/"));
  return path.join(repoRoot, TEMPLATE_DIR, trimmed);
}

/** Conditions that gate on nothing a local run can fail, so the step still has to run here. */
const ALWAYS_RUN_CONDITIONS = new Set(["succeeded()", "true", "always()", "succeededorfailed()"]);

/**
 * Read the compile-time value a step's `condition` collapses to, or null when it cannot.
 *
 * Azure DevOps expands `${{ parameters.x }}` before the pipeline runs, so a condition written
 * that way is not a runtime gate at all: it is whatever the caller passed, or the parameter's
 * declared default. Treating it as a runtime gate is what made every step in install-deps.yaml
 * look conditional the day it gained `condition: ${{ parameters.condition }}`, leaving zero
 * steps and blocking the queue for seventeen hours.
 */
function resolveCompileTimeCondition(condition, document) {
  const trimmed = condition.trim();
  const open = "${{";
  const close = "}}";
  if (!trimmed.startsWith(open) || !trimmed.endsWith(close)) return trimmed;
  const inner = trimmed.slice(open.length, trimmed.length - close.length).trim();
  const prefix = "parameters.";
  if (!inner.startsWith(prefix)) return null;
  const name = inner.slice(prefix.length).trim();
  const declared = Array.isArray(document?.parameters) ? document.parameters : [];
  for (const parameter of declared) {
    if (parameter && parameter.name === name && typeof parameter.default === "string") {
      return parameter.default.trim();
    }
  }
  return null;
}

/** Does this step run on an ordinary, everything-green pipeline? */
function isConditional(step, document) {
  if (typeof step.condition !== "string") return false;
  const resolved = resolveCompileTimeCondition(step.condition, document);
  if (resolved === null) return true;
  return !ALWAYS_RUN_CONDITIONS.has(resolved.toLowerCase());
}

/**
 * Flatten a template's steps, following nested template references.
 *
 * `depth` bounds recursion so a template cycle cannot hang the runner, and `seen` stops a
 * diamond include from contributing its steps twice.
 */
export function collectSteps(templatePath, repoRoot, yaml, seen = new Set(), depth = 0) {
  if (depth > 8) return [];
  const resolved = path.resolve(templatePath);
  if (seen.has(resolved)) return [];
  seen.add(resolved);
  if (!fs.existsSync(resolved)) return [];

  const document = yaml.parse(fs.readFileSync(resolved, "utf8"));
  const rawSteps = Array.isArray(document?.steps) ? document.steps : [];
  const steps = [];
  for (const item of rawSteps) {
    if (!item || typeof item !== "object") continue;
    const keys = Object.keys(item);
    const conditionalKey = keys.find((k) => k.startsWith("${{") && k.includes("if"));
    const elseKey = keys.find((k) => k.startsWith("${{") && k.includes("else"));
    if (conditionalKey && Array.isArray(item[conditionalKey])) {
      steps.push(...item[conditionalKey]);
      continue;
    } else if (elseKey && Array.isArray(item[elseKey])) {
      continue;
    }
    steps.push(item);
  }

  const collected = [];
  for (const step of steps) {
    if (!step || typeof step !== "object") continue;
    if (typeof step.template === "string") {
      const nested = resolveTemplateReference(step.template, repoRoot);
      if (nested) collected.push(...collectSteps(nested, repoRoot, yaml, seen, depth + 1));
      continue;
    }
    const command = typeof step.bash === "string" ? step.bash : typeof step.script === "string" ? step.script : null;
    if (command === null) continue;
    // A conditional step depends on pipeline variables that do not exist locally, so
    // running it would be guesswork. Skipping is the honest choice and is recorded.
    collected.push({
      command: command.trim(),
      displayName: typeof step.displayName === "string" ? step.displayName : command.trim(),
      conditional: isConditional(step, document),
      env: step.env && typeof step.env === "object" ? step.env : {},
    });
  }
  return collected;
}

/**
 * The dependency install sequence CI runs, read from the repo at the pinned commit.
 *
 * Returns the steps in CI order. An empty result means the templates moved, which callers
 * must treat as a failure rather than as "nothing to do".
 */
export function installSteps(repoRoot, yaml = loadYaml(repoRoot)) {
  const entry = path.join(repoRoot, TEMPLATE_DIR, "install-deps.yaml");
  if (!fs.existsSync(entry)) {
    throw new Error(
      `Cannot derive install steps: ${entry} is missing. The CI templates moved, so the analysis ` +
        `worktree can no longer be prepared the way the build was.`
    );
  }
  const steps = collectSteps(entry, repoRoot, yaml).filter((step) => !step.conditional);
  if (steps.length === 0) {
    throw new Error(`Derived zero install steps from ${entry}; refusing to assume the tree is ready.`);
  }
  return steps;
}

/**
 * Run the derived steps in the worktree.
 *
 * CI runs these under bash on Linux. Git for Windows ships bash, which every machine with
 * git already has, so the same command strings execute rather than being translated.
 */
export function runInstall(repoRoot, options = {}) {
  const steps = options.steps || installSteps(repoRoot);
  const run = options.run || runInstallStep;
  const executed = [];
  fs.rmSync(path.join(repoRoot, "node_modules", STAMP), { force: true });
  for (const step of steps) {
    options.beforeStep?.();
    const result = run(repoRoot, step);
    executed.push({ displayName: step.displayName, status: result.status });
    if (result.status !== 0) {
      throw new Error(`CI install step failed in ${repoRoot}: ${step.displayName}\n${result.output}`);
    }
  }
  options.validate?.();
  recordInstall(repoRoot);
  return executed;
}

const STAMP = ".ci-install.json";

/** The lockfile's bytes, as the one fact that decides what should be on disk. */
function lockfileFingerprint(repoRoot) {
  const pnpmLock = path.join(repoRoot, "pnpm-lock.yaml");
  if (fs.existsSync(pnpmLock)) {
    return createHash("sha256").update(fs.readFileSync(pnpmLock)).digest("hex");
  }
  const yarnLock = path.join(repoRoot, "yarn.lock");
  if (fs.existsSync(yarnLock)) {
    return createHash("sha256").update(fs.readFileSync(yarnLock)).digest("hex");
  }
  return null;
}

/** Written only once every install step has exited zero, so its presence means "finished". */
export function recordInstall(repoRoot) {
  const fingerprint = lockfileFingerprint(repoRoot);
  if (!fingerprint) return null;
  const stamp = path.join(repoRoot, "node_modules", STAMP);
  fs.mkdirSync(path.dirname(stamp), { recursive: true });
  const temporary = `${stamp}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify({ lockfile: fingerprint, at: new Date().toISOString() }), "utf8");
    fs.renameSync(temporary, stamp);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return fingerprint;
}

/**
 * Whether a *completed* install for the lockfile now on disk is on record.
 *
 * A timestamp check cannot answer this. Yarn writes node_modules/.yarn-state.yml while it
 * links, so an install that is interrupted or fails partway leaves a state file newer than the
 * lockfile over a node_modules that is missing packages. The updater's clone sat in exactly that
 * position: an install recorded 2026-08-28 with @1js/bebop-styles absent, so every prepared job
 * failed the bundle build on `@1js/bebop-styles/tokens.css` while staleness reported "current".
 *
 * A clone that has never been stamped reports false and installs once. That is the intended cost:
 * an unproven tree is indistinguishable from the broken one above.
 */
export function installIsRecorded(repoRoot) {
  const stamp = path.join(repoRoot, "node_modules", STAMP);
  if (!fs.existsSync(stamp)) return false;
  const fingerprint = lockfileFingerprint(repoRoot);
  if (!fingerprint) return false;
  try {
    return JSON.parse(fs.readFileSync(stamp, "utf8")).lockfile === fingerprint;
  } catch {
    return false;
  }
}

/**
 * Locate a bash that can actually run the CI commands.
 *
 * On Windows `bash` on PATH is `C:\Windows\System32\bash.exe`, the WSL launcher, which fails
 * with "no installed distributions" on a machine without WSL. That is not a shell at all for
 * this purpose. Git for Windows ships a real bash, and git is already required to use this
 * tool, so it is located from the git executable itself rather than assumed to be on PATH.
 */
export function resolveBash(platform = process.platform, run = spawnSync) {
  if (platform !== "win32") return "bash";
  const located = run("git", ["--exec-path"], { encoding: "utf8", windowsHide: true });
  if (located.status === 0 && located.stdout) {
    // --exec-path is <install>/mingw64/libexec/git-core; bash lives at <install>/bin/bash.exe.
    let dir = located.stdout.trim().split("/").join(path.sep);
    for (let i = 0; i < 4 && dir.length > 3; i += 1) {
      const candidate = path.join(dir, "bin", "bash.exe");
      if (fs.existsSync(candidate)) return candidate;
      dir = path.dirname(dir);
    }
  }
  for (const candidate of [
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    "No usable bash found. The CI install steps are bash scripts, and `bash` on PATH is the WSL " +
      "launcher on Windows. Install Git for Windows or make a real bash available."
  );
}

export function installEnvironment(repoRoot, step, environment = process.env, platform = process.platform) {
  const env = { ...environment, ...step.env, CI: "true", npm_config_confirm_modules_purge: "false",
    NODE_OPTIONS: step.env?.NODE_OPTIONS || environment.NODE_OPTIONS || "--max-old-space-size=16384" };
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const manager = manifest.packageManager || "";
  const major = Number(manager.slice(5).split(".")[0]);
  if (platform !== "win32" || !manager.startsWith("pnpm@") || !Number.isInteger(major) || major < 11) return env;
  const stepMethod = Object.keys(step.env || {}).find(key => key.toLowerCase() === "pnpm_config_package_import_method");
  if (stepMethod) {
    for (const key of Object.keys(env)) {
      if (key.toLowerCase() === "pnpm_config_package_import_method") delete env[key];
    }
    env[stepMethod] = step.env[stepMethod];
  }
  if (Object.keys(env).some(key => key.toLowerCase() === "pnpm_config_package_import_method")) return env;
  const workspace = path.join(repoRoot, "pnpm-workspace.yaml");
  if (fs.existsSync(workspace) && loadYaml(repoRoot).parse(fs.readFileSync(workspace, "utf8"))?.packageImportMethod !== undefined) return env;
  // Let pnpm isolate packages that need builds or patches; never hardlink node_modules ourselves.
  env.pnpm_config_package_import_method = "hardlink";
  return env;
}

export function runInstallStep(repoRoot, step, {
  spawn = spawnSync, environment = process.env, logDirectory = installLogDirectory(),
} = {}) {
  const env = installEnvironment(repoRoot, step, environment);
  const startedAt = Date.now();
  fs.mkdirSync(logDirectory, { recursive: true });
  const logFile = path.join(path.resolve(logDirectory), `install-${startedAt}-${process.pid}-${randomUUID()}.log`);
  const fd = fs.openSync(logFile, "ax");
  const key = Object.keys(env).find(name => name.toLowerCase() === "pnpm_config_package_import_method");
  const progress = { state: "running", startedAt, logFile, pid: process.pid, importMethod: key ? env[key] : "repository policy" };
  let result;
  try {
    writeInstallProgress(repoRoot, progress, logDirectory);
    result = spawn(resolveBash(), ["-lc", step.command], {
      cwd: repoRoot, encoding: "utf8", windowsHide: true,
      stdio: ["pipe", fd, fd], env,
    });
  } catch (error) {
    writeInstallProgress(repoRoot, { ...progress, state: "failed", endedAt: Date.now() }, logDirectory);
    throw error;
  } finally {
    fs.closeSync(fd);
  }
  writeInstallProgress(repoRoot, { ...progress, state: result.status === 0 && !result.error && !result.signal ? "completed" : "failed",
    endedAt: Date.now(), status: result.status ?? -1 }, logDirectory);
  const output = `${readLogTail(logFile)}${result.stdout || ""}${result.stderr || ""}\nFull CI install log: ${logFile}`;
  // Put process failures first so downstream summaries cannot bury them under install progress.
  if (result.error) {
    const reason = result.error.code === "ETIMEDOUT"
      ? "CI install process timed out (ETIMEDOUT)"
      : result.error.message;
    return { status: result.status ?? -1, output: `Error: ${reason}\n${output}`.trim() };
  }
  if (result.signal) return { status: result.status ?? -1, output: `Error: CI install terminated by ${result.signal}\n${output}`.trim() };
  return { status: result.status, output };
}
