import { existsSync, linkSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, symlinkSync } from "node:fs";
import path from "node:path";
import { runnerNames, loadWorkflowConfig } from "./workflow-store.mjs";
import { runnerStates } from "./health.mjs";

export async function migrateRunnerInstallation(home, config, projects) {
  if (!home || !config || !existsSync(config)) return;
  const physical = value => realpathSync.native(value).toLowerCase();
  const old = JSON.parse(readFileSync(config, "utf8"));
  const project = projects.find(project => physical(project.root) === physical(old.spool_dir));
  if (!project) throw new Error("Legacy runners do not belong to a registered project.");
  const runtime = path.join(project.root, ".runner", "automation");
  const target = path.join(runtime, "spool-runners.json"), runners = path.join(home, "runners");
  if (existsSync(target)) {
    const left = statSync(target), right = statSync(config);
    if (left.ino === right.ino && left.dev === right.dev) return;
    throw new Error("Both legacy and application runner configurations exist. Resolve the duplicate before starting runners.");
  }
  const input = loadWorkflowConfig(config, project.root);
  const states = await runnerStates(runnerNames(input), runners);
  if (states.some(row => row.running)) throw new Error("Standalone runners are still running. Drain their supervisor before migrating.");
  mkdirSync(runtime, { recursive: true });
  const destination = path.join(runtime, "runners");
  if (existsSync(destination) && (!existsSync(runners) || physical(destination) !== physical(runners)))
    throw new Error("Runner migration target already contains state.");
  if (existsSync(runners) && !existsSync(destination)) {
    renameSync(runners, destination);
    try { symlinkSync(destination, runners, process.platform === "win32" ? "junction" : "dir"); }
    catch (error) { renameSync(destination, runners); throw error; }
  }
  renameSync(config, target);
  try { linkSync(target, config); } catch (error) { renameSync(target, config); throw error; }
}
