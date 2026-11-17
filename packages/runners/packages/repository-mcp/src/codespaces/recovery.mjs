import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { withWorkspaceLock } from "../process.mjs";
import { repositoryProfile } from "../adapters/1js-profile.mjs";
import { isCodespaceCheckout } from "./config.mjs";

export function preservePrebootLock(file, {
  bootTime = Date.now() - os.uptime() * 1000,
  alive = pid => {
    try { process.kill(pid, 0); return true; }
    catch (error) { if (error.code === "ESRCH") return false; throw error; }
  },
  assertIdle,
} = {}) {
  if (!fs.existsSync(file)) return null;
  if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink())
    throw new Error(`Interrupted Codespace lock is not a regular file: ${file}`);
  const original = fs.readFileSync(file, "utf8"), owner = JSON.parse(original);
  const started = Date.parse(owner.startedAt || owner.at || "");
  const validPid = Number.isSafeInteger(owner.pid) && owner.pid > 0;
  if (validPid && alive(owner.pid))
    throw Object.assign(new Error(`Codespace lock cannot be proven to belong to a dead pre-boot owner: ${file}; ` +
      `CODESPACE_WORKSPACE_BUSY: live operation ${owner.pid} owns this workspace`),
    { code: "CODESPACE_WORKSPACE_BUSY", reasonCode: "workspace_busy" });
  if (!validPid || !Number.isFinite(started) || !Number.isFinite(bootTime))
    throw new Error(`Codespace lock cannot be proven to belong to a dead pre-boot owner: ${file}`);
  if (started >= bootTime - 10000) {
    if (typeof assertIdle !== "function" || started > Date.now() ||
        !/^[a-f0-9-]{36}$/.test(owner.token || ""))
      throw new Error(`Codespace lock cannot be proven to belong to a dead pre-boot owner: ${file}`);
    assertIdle({ ...owner, startedAt: owner.startedAt || owner.at });
    if (alive(owner.pid)) throw new Error(`Codespace lock owner became live during recovery: ${file}`);
  }
  if (fs.readFileSync(file, "utf8") !== original)
    throw new Error(`Codespace lock changed during recovery: ${file}`);
  const archive = `${file}.stale-${createHash("sha256").update(original).digest("hex").slice(0, 16)}`;
  if (fs.existsSync(archive)) throw new Error(`Interrupted Codespace lock archive already exists: ${archive}`);
  fs.renameSync(file, archive);
  return archive;
}

export function assertNativeWorkspaceIdle(root, remoteTools, owner, options) {
  for (let attempt = 0; ; attempt++) {
    try { return inspectNativeWorkspaceIdle(root, remoteTools, owner, options); }
    catch (error) {
      if (!["EACCES", "ENOENT"].includes(error.code) || attempt === 9) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

function nativeProcessReader({
  procRoot = "/proc",
  bootTime = Date.now() - os.uptime() * 1000,
  clockTicks = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim()),
} = {}) {
  if (!Number.isFinite(clockTicks) || clockTicks <= 0 || !Number.isFinite(bootTime))
    throw new Error("Cannot verify native process start times");
  return pid => {
    const text = fs.readFileSync(path.join(procRoot, String(pid), "stat"), "utf8");
    const fields = text.slice(text.lastIndexOf(")") + 2).trim().split(/\s+/);
    const ppid = Number(fields[1]), group = Number(fields[2]), started = Number(fields[19]);
    if (![ppid, group, started].every(value => Number.isSafeInteger(value) && value >= 0))
      throw new Error(`Cannot verify native process identity: ${pid}`);
    return { ppid, group, started: bootTime + started / clockTicks * 1000, zombie: fields[0] === "Z" };
  };
}

export function nativeBootTime(options) {
  // Kernel uptime belongs to the host VM, not necessarily this container.
  const init = nativeProcessReader(options)(1);
  if (init.ppid !== 0 || init.zombie || init.started > Date.now())
    throw new Error("Cannot verify native process namespace boot time");
  return init.started;
}

function inspectNativeWorkspaceIdle(root, remoteTools, owner, {
  currentPid = process.pid, lifecyclePid, ...clock
} = {}) {
  const readProcess = nativeProcessReader(clock);
  const ancestors = new Set();
  for (const ownerPid of [currentPid, lifecyclePid])
    for (let pid = ownerPid; pid > 1 && !ancestors.has(pid);) {
      ancestors.add(pid);
      pid = readProcess(pid).ppid;
    }
  const related = value => [root, remoteTools].some(directory =>
    value === directory || value.startsWith(directory + "/"));
  const predatesOwner = value => value.started < Date.parse(owner.startedAt) - 2000;
  const independentService = pid => {
    const visited = new Set();
    while (pid > 1 && !visited.has(pid)) {
      if (pid === owner.pid) return false;
      visited.add(pid);
      const current = readProcess(pid);
      if (Number.isSafeInteger(owner.processGroup) && current.group === owner.processGroup) return false;
      if (predatesOwner(current)) return true;
      pid = current.ppid;
    }
    return false;
  };
  const busy = pid => Object.assign(new Error(
    `CODESPACE_WORKSPACE_BUSY: process ${pid} may still own interrupted workspace work`),
  { code: "CODESPACE_WORKSPACE_BUSY", reasonCode: "workspace_busy" });
  for (const name of fs.readdirSync(procRoot).filter(name => /^\d+$/.test(name))) {
    const pid = Number(name);
    if (ancestors.has(pid)) continue;
    const directory = path.join(procRoot, name);
    try {
      const process = readProcess(pid);
      if (process.zombie) continue;
      if (Number.isSafeInteger(owner.processGroup) && process.group === owner.processGroup) throw busy(pid);
      // Older editor/services cannot descend from the interrupted operation.
      if (predatesOwner(process)) continue;
      const args = fs.readFileSync(path.join(directory, "cmdline"), "utf8").split("\0");
      const command = args.at(-1) === "" ? args.slice(0, -1) : args;
      if (command.length === 3 && ["bash", "/bin/bash", "/usr/bin/bash"].includes(command[0]) &&
          command[1] === "-c" &&
          command[2] === 'while IFS= read -r -t 60 line; do test "$line" = heartbeat || exit 1; done')
        continue;
      if (args.some(arg => arg.includes(root) || arg.includes(remoteTools))) throw busy(pid);
      const cwd = fs.readlinkSync(path.join(directory, "cwd"));
      if (related(cwd)) throw busy(pid);
      for (const descriptor of fs.readdirSync(path.join(directory, "fd"))) {
        let target;
        try { target = fs.readlinkSync(path.join(directory, "fd", descriptor)); }
        catch (error) { if (error.code === "ENOENT") continue; throw error; }
        if (related(target)) throw busy(pid);
      }
    } catch (error) {
      if (["ENOENT", "EACCES"].includes(error.code)) {
        try { if (readProcess(pid).zombie) continue; }
        catch (current) { if (current.code === "ENOENT") continue; throw current; }
      }
      if (error.code === "EACCES" && independentService(pid)) continue;
      throw error;
    }
  }
}

export function assertWindowsWorkspaceIdle(owner, {
  currentPid = process.pid,
  readProcesses = () => JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name," +
    "@{Name='StartedAt';Expression={if ($_.CreationDate) {$_.CreationDate.ToUniversalTime().ToString('o')}}} | ConvertTo-Json -Compress"],
  { encoding: "utf8", windowsHide: true, maxBuffer: 4 * 1024 * 1024 })),
} = {}) {
  const values = readProcesses(), started = Date.parse(owner.startedAt || owner.at || "");
  if (!Array.isArray(values) || !Number.isFinite(started) ||
      values.some(value => !Number.isSafeInteger(value.ProcessId) || value.ProcessId < 0 ||
        !Number.isSafeInteger(value.ParentProcessId) || value.ParentProcessId < 0 ||
        typeof value.Name !== "string" || !value.Name))
    throw new Error("Cannot verify Windows workspace process identities");
  const processes = new Map(values.map(value => [value.ProcessId, value]));
  if (processes.size !== values.length || !processes.has(currentPid))
    throw new Error("Cannot verify Windows workspace caller identity");
  const busy = pid => Object.assign(new Error(
    `CODESPACE_WORKSPACE_BUSY: process ${pid} may still own interrupted host workspace work`),
  { code: "CODESPACE_WORKSPACE_BUSY", reasonCode: "workspace_busy" });
  if (processes.has(owner.pid)) throw busy(owner.pid);
  const ancestors = new Set();
  for (let value = processes.get(currentPid); value && value.ProcessId > 0; value = processes.get(value.ParentProcessId)) {
    if (ancestors.has(value.ProcessId)) throw new Error("Cannot verify Windows process ancestry");
    if (value.ParentProcessId === owner.pid) throw busy(value.ProcessId);
    ancestors.add(value.ProcessId);
    const parent = processes.get(value.ParentProcessId);
    if (parent?.ProcessId > 0 && (!Number.isFinite(Date.parse(value.StartedAt || "")) ||
        !Number.isFinite(Date.parse(parent.StartedAt || "")) ||
        Date.parse(parent.StartedAt) > Date.parse(value.StartedAt) + 2000))
      throw new Error("Cannot verify Windows workspace caller ancestry");
  }
  for (const value of values) {
    if (ancestors.has(value.ProcessId)) continue;
    let independent = false;
    const visited = new Set();
    for (let current = value; current; current = processes.get(current.ParentProcessId)) {
      if (visited.has(current.ProcessId)) throw new Error("Cannot verify Windows process ancestry");
      visited.add(current.ProcessId);
      if (current.ParentProcessId === owner.pid) throw busy(value.ProcessId);
      const time = Date.parse(current.StartedAt || "");
      if (!Number.isFinite(time)) {
        if (/^(node|gh|ssh)(?:\.exe)?$/i.test(value.Name || ""))
          throw new Error("Cannot verify Windows workspace process start time");
        break;
      }
      if (ancestors.has(current.ProcessId) || time < started - 2000) {
        independent = true;
        break;
      }
      const parent = processes.get(current.ParentProcessId);
      if (parent && Date.parse(parent.StartedAt || "") > time + 2000) break;
    }
    if (!independent && /^(node|gh|ssh)(?:\.exe)?$/i.test(value.Name || "")) throw busy(value.ProcessId);
  }
}

export function withCodespaceWorkspaceLock(workspace, operation, {
  assertIdle = owner => process.platform === "win32" ? assertWindowsWorkspaceIdle(owner)
    : assertNativeWorkspaceIdle(workspace, workspace, owner),
} = {}) {
  const lock = path.join(workspace, "repository-mcp.lock");
  if (!fs.existsSync(lock)) return withWorkspaceLock(workspace, operation);
  const guard = `${lock}.recovery`, owner = `${process.pid}\n`;
  const descriptor = fs.openSync(guard, "wx");
  try {
    fs.writeFileSync(descriptor, owner);
    preservePrebootLock(lock, { assertIdle });
    // Acquire the replacement lock synchronously before releasing recovery ownership.
    return withWorkspaceLock(workspace, operation);
  } finally {
    fs.closeSync(descriptor);
    if (fs.readFileSync(guard, "utf8") !== owner) throw new Error("Codespace recovery ownership changed");
    fs.unlinkSync(guard);
  }
}

export function recoverNativeCodespaceLocks(root, storage, remoteTools, token) {
  if (!isCodespaceCheckout(root) || storage !== "/workspaces" ||
      !/^\/workspaces\/\.spool-[a-z0-9-]+-tools$/.test(remoteTools) ||
      !/^[a-f0-9-]{36}$/.test(token || ""))
    throw new Error("Codespace recovery requires its registered native paths and owned lifecycle");
  if (fs.realpathSync(root) !== root) throw new Error("Codespace checkout redirects");
  const owner = JSON.parse(fs.readFileSync(`${remoteTools}.owner.json`, "utf8"));
  if (owner.token !== token || !Number.isSafeInteger(owner.pid)) throw new Error("Codespace lifecycle ownership changed");
  process.kill(owner.pid, 0);
  const { stateRoot } = repositoryProfile({ repoRoot: root, storageRoot: storage,
    baseBranch: "main", nodeExecutable: process.execPath });
  const gitDirectory = execFileSync("git", ["--no-pager", "-C", root, "rev-parse", "--absolute-git-dir"],
    { encoding: "utf8" }).trim();
  const files = [
    path.join(gitDirectory, "repository-mcp.lock"),
    path.join(gitDirectory, "spool-review", "repository-mcp.lock"),
    path.join(gitDirectory, "bohemia-workspace.lock"),
    path.join(storage, "repository-mcp-store", "repository-mcp.lock"),
    path.join(stateRoot, "repository-mcp.lock"),
  ];
  const bootTime = nativeBootTime();
  return files.map(file => preservePrebootLock(file, {
    bootTime,
    assertIdle: operation => assertNativeWorkspaceIdle(root, remoteTools, operation, { lifecyclePid: owner.pid }),
  })).filter(Boolean);
}
