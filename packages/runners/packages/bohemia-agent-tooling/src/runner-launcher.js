import { closeSync, mkdirSync, openSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { assertRunnerEntry, isProcessAlive, readRunnerState, runtimePaths } from "./supervisor.js";
import { isRunnerProcess, windowsProcesses } from "./windows-processes.js";

export async function startRunner(runner, {
  timeoutMs = 120_000, pollMs = 250, env = process.env, spawnImpl = spawn,
  processes = process.platform === "win32" ? windowsProcesses() : null,
} = {}) {
  assertRunnerEntry(runner);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 ||
      !Number.isFinite(pollMs) || pollMs <= 0) throw new Error("Invalid runner startup timeout");
  const initial = readRunnerState(runner, processes ? {
    isAlive: pid => isRunnerProcess(processes, pid, runner.entry),
  } : {});
  const existing = processes?.find(p => isRunnerProcess(processes, p.ProcessId, runner.entry));
  if (initial.ready) return initial;
  const { runtime } = runtimePaths(runner);
  let child;
  let launchError;
  if (!initial.running && !existing) {
    mkdirSync(runtime, { recursive: true });
    const descriptors = [];
    try {
      descriptors.push(openSync(path.join(runtime, "runner.log"), "a"));
      descriptors.push(openSync(path.join(runtime, "runner-error.log"), "a"));
      child = spawnImpl(process.execPath, [runner.entry], {
        cwd: runner.directory, env, detached: true, windowsHide: true,
        stdio: ["ignore", ...descriptors],
      });
      child.once("error", error => { launchError = error; });
      child.unref();
    } finally {
      for (const descriptor of descriptors) closeSync(descriptor);
    }
  }
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (launchError) throw new Error(`${runner.name} launch failed: ${launchError.message}`, { cause: launchError });
    const state = readRunnerState(runner);
    if (state.ready) {
      if (process.platform === "win32" && !isRunnerProcess(windowsProcesses(), state.pid, runner.entry)) {
        throw new Error(`${runner.name} readiness record belongs to a different process`);
      }
      return state;
    }
    if (state.running && state.lastError) {
      throw new Error(`${runner.name} is degraded: ${state.lastError}; preserving its process`);
    }
    if (child && (child.exitCode !== null || child.signalCode !== null) && !state.running) {
      throw new Error(`${runner.name} exited before readiness; see ${path.join(runtime, "runner-error.log")}`);
    }
    if (!child && !isProcessAlive(initial.pid || existing?.ProcessId)) {
      throw new Error(`${runner.name} exited while waiting for readiness`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`${runner.name} has not completed a successful scan within ${timeoutMs}ms; preserving live work`);
    }
    await delay(pollMs);
  }
}
