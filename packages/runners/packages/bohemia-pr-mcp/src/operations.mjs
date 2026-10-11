import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { executePreparation, preparationProcessAlive } from "./preparation-process.mjs";
import { assertPreparationCapacity } from "./preparation-capacity.mjs";
import { isTaskWorkspace, preparationBlocked } from "./resume-state.mjs";
import { prepareBranch, refreshUnchanged } from "./prepare-branch.mjs";
const defaultGate = fileURLToPath(new URL("../../dedicated-runners/repo-gates/bohemia.ps1", import.meta.url));
function requiredText(value, name) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new Error(`${name} is required`);
  return value.trim();
}
function ref(value, name) {
  const text = requiredText(value, name);
  if (text.startsWith("-") || /[\s~^:?*\[\\]/.test(text) || text.includes("..") || text.includes("@{")) {
    throw new Error(`Invalid ${name}`);
  }
  return text.replace(/^refs\/heads\//, "");
}
export function validateOperation(action, input) {
  if (!["prepare", "build", "check", "push"].includes(action)) throw new Error("Unknown Bohemia operation");
  if (!path.isAbsolute(requiredText(input.repoRoot, "repoRoot"))) throw new Error("repoRoot must be absolute");
  if (action === "prepare" && isTaskWorkspace(input.repoRoot)) {
    throw preparationBlocked("Task-specific checkouts are retired; prepare the agent's assigned repository instead", "retired_task_workspace");
  }
  if (input.seedRoot !== undefined && !path.isAbsolute(requiredText(input.seedRoot, "seedRoot"))) throw new Error("seedRoot must be absolute");
  if (input.minimumFreeGiB !== undefined && (typeof input.minimumFreeGiB !== "number" || !Number.isFinite(input.minimumFreeGiB) || input.minimumFreeGiB <= 0)) throw new Error("minimumFreeGiB must be positive");
  for (const key of ["reset", "mergeMaster", "runSetup", "runBuild", "allowConflicts", "productionArtifacts", "prepareTests"]) {
    if (input[key] !== undefined && typeof input[key] !== "boolean") throw new Error(`${key} must be boolean`);
  }
  if (input.packages !== undefined && (!Array.isArray(input.packages) || input.packages.some(value =>
    typeof value !== "string" || !/^[a-zA-Z0-9@/._-]+$/.test(value) || value.startsWith("-")))) {
    throw new Error("packages must contain valid package names");
  }
  if (input.baseBranch !== undefined) ref(input.baseBranch, "baseBranch");
  if (action === "push") {
    ref(input.branch, "branch");
    if (!input.expectedHead) throw new Error("Checked publication requires expectedHead");
  }
  if (input.productionArtifacts && (action !== "build" || !input.packages?.length)) {
    throw new Error("productionArtifacts requires bohemia_build with explicit packages");
  }
  if (input.prepareTests && (action !== "build" || !input.packages?.length || input.productionArtifacts))
    throw new Error("prepareTests requires a dependency build with explicit packages, not productionArtifacts");
  for (const name of ["sourceCommit", "expectedHead"]) {
    if (input[name] !== undefined && (typeof input[name] !== "string" || !/^[0-9a-f]{40}$/i.test(input[name]))) throw new Error(`${name} must be an exact SHA`);
  }
  if (action !== "prepare") {
    if (input.reset || input.mergeMaster) throw new Error("Build/check cannot reset or merge a checkout");
    return;
  }
  const operation = input.operation || "branch";
  if (!["branch", "master", "setup"].includes(operation)) throw new Error("Unknown preparation operation");
  const mode = input.mode || "checkout";
  if (!["create", "checkout", "resume"].includes(mode)) throw new Error("Unknown branch mode");
  if (operation === "branch") ref(input.branch, "branch");
  if (input.reset && (operation !== "branch" || mode === "resume")) throw new Error("Reset is only valid for explicit fresh branch preparation");
  if (input.sourceCommit && (mode === "create" || input.mergeMaster)) throw new Error("Exact-revision review cannot create from master or merge another revision");
  if (operation !== "branch" && (input.mergeMaster || input.sourceCommit)) throw new Error("Master refresh/setup cannot reposition the working branch");
}
export function runOperation(action, input, dependencies = {}) {
  validateOperation(action, input);
  const environment = { ...(dependencies.environment || process.env),
    ...(input.minimumFreeGiB !== undefined ? { BOHEMIA_MIN_FREE_GIB: String(input.minimumFreeGiB) } : {}) };
  const run = dependencies.execute || ((exe, args, cwd, timeout) => executePreparation(exe, args, cwd, environment, timeout));
  const root = path.resolve(input.repoRoot);
  const capacity = () => assertPreparationCapacity({ creatorMinimumFreeGiB: input.minimumFreeGiB }, root);
  capacity();
  const command = (exe, args, cwd = root, allowFailure = false, timeout = 5_400_000) => {
    const raw = run(exe, args, cwd, timeout);
    const redact = text => (dependencies.redactions || []).reduce((value, secret) => value.replaceAll(secret, "[redacted]"), text);
    const result = { ...raw, output: redact(raw.output),
      ...(raw.stdout !== undefined ? { stdout: redact(raw.stdout) } : {}) };
    if (result.code !== 0 && !allowFailure) throw new Error(`${exe} ${args[0]} failed (${result.code}): ${result.output.slice(-16_000)}`);
    return result;
  };
  const git = (...args) => {
    const result = command("git", args);
    return (result.stdout ?? result.output).trim();
  };
  const gitPath = name => path.resolve(root, git("rev-parse", "--git-path", name));
  let created = false;
  if (!fs.existsSync(root)) {
    if (action !== "prepare" || (input.operation || "branch") !== "branch" || !input.seedRoot) throw new Error(`Checkout does not exist: ${root}`);
    const seed = fs.realpathSync(input.seedRoot);
    if (!fs.existsSync(path.join(seed, ".git"))) throw new Error("seedRoot must be an existing repository");
    const remote = command("git", ["remote", "get-url", "origin"], seed).output.trim();
    fs.mkdirSync(path.dirname(root), { recursive: true });
    command("git", ["clone", "--local", "--no-checkout", "--", seed, root], seed);
    git("remote", "set-url", "origin", remote);
    git("config", "core.longpaths", "true");
    git("config", "maintenance.auto", "false");
    git("config", "gc.auto", "0");
    created = true;
  }
  if (git("rev-parse", "--show-prefix") !== "") {
    throw new Error("repoRoot must name the checkout root, not a parent or subdirectory");
  }
  const lockPath = gitPath("bohemia-workspace.lock");
  let lock;
  try { lock = fs.openSync(lockPath, "wx"); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    const recoveryPath = `${lockPath}.recovery`;
    const recovery = fs.openSync(recoveryPath, "wx");
    try {
      const owner = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      if (preparationProcessAlive(owner.pid)) throw new Error("Workspace preparation still has a live owner or child; checkout preserved");
      fs.unlinkSync(lockPath);
      lock = fs.openSync(lockPath, "wx");
    } finally {
      fs.closeSync(recovery);
      fs.unlinkSync(recoveryPath);
    }
  }
  const steps = [];
  const started = Date.now();
  const statePath = gitPath("bohemia-preparation.json");
  const writeState = value => {
    const temporary = `${statePath}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(value));
      fs.renameSync(temporary, statePath);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  };
  let previous = null;
  const stage = (name, fn) => {
    capacity();
    const at = Date.now();
    const head = git("rev-parse", "HEAD");
    writeState({ action, branch: input.branch, stage: name, state: "started", head, pid: process.pid, at });
    try {
      const result = fn();
      steps.push({ name, ms: Date.now() - at });
      writeState({ action, branch: input.branch, stage: name, state: "completed", head, pid: process.pid, steps });
      return result;
    } catch (error) {
      writeState({ action, branch: input.branch, stage: name, state: "failed", head, error: error.message, steps });
      throw error;
    }
  };
  const gate = verb => stage(verb, () => {
    const script = dependencies.gateScript || process.env.BOHEMIA_GATE_SCRIPT || defaultGate;
    if (!fs.existsSync(script)) throw new Error(`Bohemia gate is unavailable: ${script}`);
    const args = ["-NoProfile", "-NonInteractive", "-File", script, verb, "-RepoRoot", root];
    if (verb === "check") args.push("-TargetBranch", `origin/${ref(input.baseBranch || "master", "baseBranch")}`);
    if (input.packages?.length && verb !== "check") args.push("-Packages", input.packages.join(","));
    if (verb === "build" && input.productionArtifacts) args.push("-ProductionArtifacts");
    if (verb === "build" && input.prepareTests) args.push("-PrepareTests");
    if (verb === "setup" && input.runBuild === false) args.push("-SkipWarmBuild");
    // The gate owns per-step deadlines and process-tree cleanup, including multi-step setup.
    command("pwsh", args, root, false, 0);
  });
  let merge = null;
  try {
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, action, at: new Date().toISOString() }));
    previous = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : null;
    if (action === "push") {
      const branch = ref(input.branch, "branch");
      const verify = () => {
        if (git("branch", "--show-current") !== branch || git("rev-parse", "HEAD") !== input.expectedHead ||
            git("status", "--porcelain")) throw new Error("Publication checkout changed; refusing to push");
      };
      verify();
      gate("check");
      verify();
      stage("push", () => git("push", "origin", `${input.expectedHead}:refs/heads/${branch}`));
      const remote = git("ls-remote", "--heads", "origin", `refs/heads/${branch}`).split("\t")[0];
      if (remote !== input.expectedHead) throw new Error("Remote branch does not match the checked publication commit");
    } else if (action === "build" || action === "check") {
      gate(action);
      if (input.prepareTests) stage("test-readiness", () => {
        refreshUnchanged(command);
        if (git("status", "--porcelain")) throw new Error("Test preparation changed checkout files; refusing a dirty review handoff");
      });
    } else {
      const operation = input.operation || "branch";
      const base = ref(input.baseBranch || "master", "baseBranch");
      if (operation === "master") {
        stage("fetch-master", () => git("fetch", "--no-tags", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`));
      } else if (operation === "branch") {
        merge = prepareBranch({ input, root, base, branch: ref(input.branch, "branch"),
          created, previous, git, gitPath, command, stage });
      }
      if (operation === "setup" || (operation === "branch" && input.runSetup !== false)) gate("setup");
      if (input.runBuild && input.runSetup === false && operation !== "master") gate("build");
      if (operation === "branch" && !merge?.conflicted) {
        refreshUnchanged(command);
        if (git("status", "--porcelain")) throw new Error("Preparation changed tracked or untracked files; refusing a dirty handoff");
      }
    }
    const result = { ok: true, ready: true, root, repoRoot: root, branch: git("branch", "--show-current"),
      commit: git("rev-parse", "HEAD"), sourceCommit: input.sourceCommit, merge, steps,
      buildWarmed: steps.some(step => step.name === "build" || (step.name === "setup" && input.runBuild !== false)),
      ...(input.productionArtifacts ? { productionArtifacts: true } : {}),
      ms: Date.now() - started };
    writeState({ ...result, state: "completed" });
    return result;
  } finally {
    fs.closeSync(lock);
    fs.unlinkSync(lockPath);
  }
}
