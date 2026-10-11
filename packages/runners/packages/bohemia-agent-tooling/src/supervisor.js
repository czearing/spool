import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { readRunnerJson, runnerError, writeRunnerJson } from "./runner-files.js";

/**
 * Process supervision for long running tools.
 *
 * A tool that polls an external system runs as a process rather than as one cycle, so the shared
 * question is not "what did the cycle do" but "is this runner alive, and is it still working". Both
 * answers are read from files the runner itself writes, never from a live handle, so any command line
 * can answer them without owning the process.
 *
 * Nothing here names a tool. A runner is any directory holding a manifest.
 */

const MANIFEST = "runner.json";
const RUNTIME = ".runner";
const PID_RECORD = "pid.json";
const STATUS_RECORD = "status.json";

/** Minimum staleness budget, so a fast poll cannot declare itself stale on one slow scan. */
const MINIMUM_FRESH_SECONDS = 120;

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Find every runner under a root. Depth is bounded because a runner is a direct child of the root,
 * and an unbounded walk would find manifests inside dependency trees.
 */
export function discoverRunners(root, depth = 2) {
  const found = [];
  const walk = (directory, level) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name === MANIFEST) {
        const manifest = readJson(join(directory, entry.name));
        if (manifest?.name && manifest?.entry) {
          found.push({
            name: manifest.name,
            directory,
            entry: resolve(directory, manifest.entry),
            manifest,
          });
        }
        continue;
      }
      if (!entry.isDirectory() || level >= depth) continue;
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      walk(join(directory, entry.name), level + 1);
    }
  };
  walk(root, 0);
  return found.sort((left, right) => left.name.localeCompare(right.name));
}

export function runtimePaths(runner) {
  const runtime = join(runner.directory, RUNTIME);
  return {
    runtime,
    pidFile: join(runtime, PID_RECORD),
    statusFile: join(runtime, STATUS_RECORD),
  };
}

export function writePidRecord(pidFile, record) {
  writeRunnerJson(pidFile, record);
}

export function clearPidRecord(pidFile) {
  if (existsSync(pidFile)) rmSync(pidFile, { force: true });
}

/**
 * Whether a recorded process id is still a live process.
 *
 * Signal 0 asks the operating system without touching the process. EPERM means the id exists and is
 * owned by somebody else, which still answers the question that was asked.
 *
 * This answers whether the id is occupied, not whether it is occupied by the recorded process. Pass
 * an observed process table to readRunnerState when the difference matters, which it does on any
 * host that recycles ids quickly.
 */
export function isProcessAlive(processId, kill = process.kill.bind(process)) {
  if (!Number.isInteger(processId) || processId <= 0) return false;
  try {
    kill(processId, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/**
 * Read one runner's state.
 *
 * Running is deliberately two facts, not one. A process that exists but has not scanned within its
 * own poll budget is reported as running and stale, because a supervisor that reported it healthy is
 * exactly how a dead delivery path stays hidden.
 */
export function readRunnerState(runner, options = {}) {
  const now = options.now ? options.now.getTime() : Date.now();
  const alive = options.isAlive ?? isProcessAlive;
  const { pidFile, statusFile } = runtimePaths(runner);
  const pidRecord = readRunnerJson(pidFile);
  const status = readRunnerJson(statusFile);
  const processId = Number(pidRecord?.pid ?? status?.pid ?? 0);
  const running = alive(processId);

  const lastScan = status?.lastScan ? Date.parse(status.lastScan) : Number.NaN;
  const ageSeconds = Number.isFinite(lastScan) ? (now - lastScan) / 1000 : null;
  const freshLimit = Math.max(MINIMUM_FRESH_SECONDS, Number(status?.pollSeconds ?? 20) * 3);
  const sameInstance = (!pidRecord?.instanceId || pidRecord.instanceId === status?.instanceId) &&
    (!pidRecord || !status?.pid || Number(pidRecord.pid) === Number(status.pid));
  const stale = running && (!sameInstance || ageSeconds === null || ageSeconds > freshLimit);
  const lastError = runnerError(status);
  const ready = running && !stale && !lastError &&
    (!status?.phase || ["ready", "scanning"].includes(status.phase));

  return {
    name: runner.name,
    entry: runner.entry,
    pid: processId || null,
    running,
    stale,
    ready,
    phase: status?.phase ?? null,
    startedAt: pidRecord?.startedAt ?? null,
    lastScan: status?.lastScan ?? null,
    ageSeconds: ageSeconds === null ? null : Math.round(ageSeconds),
    nextScan: status?.nextScan ?? null,
    lastError,
    counts: status?.counts ?? null,
    status,
  };
}

export function readAllRunnerStates(root, options = {}) {
  return discoverRunners(root, options.depth).map((runner) => readRunnerState(runner, options));
}

/** Whether the file a manifest points at is present, so a broken migration fails loudly. */
export function assertRunnerEntry(runner) {
  if (!existsSync(runner.entry)) {
    throw new Error(`runner "${runner.name}" points at a missing entry: ${runner.entry}`);
  }
  if (!statSync(runner.entry).isFile()) {
    throw new Error(`runner "${runner.name}" entry is not a file: ${runner.entry}`);
  }
  return true;
}
