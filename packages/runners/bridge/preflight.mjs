import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverRunners, readRunnerState, windowsProcesses, isRunnerProcess, requestRunnerStop } from "../packages/bohemia-agent-tooling/src/index.js";
import { agents, configure, keyFor, readConfiguration } from "./config.mjs";
import { assertCanonicalSources, engineRoot } from "./sources.mjs";
import { SpoolStore } from "./spool-store.mjs";
import { validateWorkflow } from "./workflow-schema.mjs";
import { definition, runnerNames, runnerSetting } from "./workflow-store.mjs";
import { eventSource } from "@spool/workflow";
import { eventConfiguration } from "./workflow-event-config.mjs";
import { runtimeRoot } from "./runtime-root.mjs";

export async function preflight(input, { retireLegacy = false } = {}) {
  assertCanonicalSources();
  const enabled = Object.keys(agents).filter(name => input[keyFor(name)]?.enabled);
  for (const value of Object.values(input.custom_runners || {})) validateWorkflow(value);
  for (const name of runnerNames(input).filter(id => runnerSetting(input, id).enabled)) {
    const workflow = definition(input, name), source = eventSource(workflow);
    if (!source) continue;
    validateWorkflow(workflow);
    const { config } = configure(eventConfiguration(input, workflow), source, path.join(runtimeRoot(), "runners", name));
    if (source === "pr-reviewer" ? !config.reviewer : !["livesite", "spelling"].includes(source) && (!config.creatorId || !config.authorAccount)) {
      throw new Error(`${name} requires ado.creator_id and ado.author_account (or an explicit reviewer for review events)`);
    }
  }
  new SpoolStore(input.spool_dir).tasks();
  const processes = windowsProcesses();
  const legacy = discoverRunners(engineRoot).map(runner => ({
    ...runner, state: readRunnerState(runner, { isAlive: pid => isRunnerProcess(processes, pid, runner.entry) }),
  })).filter(runner => runner.state.running);
  if (legacy.length && !retireLegacy) throw new Error("Legacy Paperclip dispatchers are still running; use install-runners.ps1 to drain them safely");
  for (const runner of legacy) {
    await requestRunnerStop(runner.entry, runner.state.pid);
    console.log(`Draining legacy dispatcher ${runner.name}; agent executions are untouched`);
  }
  const deadline = Date.now() + 180_000;
  while (legacy.length) {
    const current = windowsProcesses();
    if (legacy.every(runner => !isRunnerProcess(current, runner.state.pid, runner.entry))) break;
    if (Date.now() >= deadline) throw new Error("Legacy dispatchers are still draining; migration held without stopping their work");
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  console.log(`Preflight passed: ${enabled.length} configured runners, no competing legacy dispatchers`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const input = process.env.SPOOL_RUNNER_CONFIG ? JSON.parse(process.env.SPOOL_RUNNER_CONFIG) : readConfiguration(process.argv[2]);
  await preflight(input, { retireLegacy: process.argv.includes("--retire-legacy") });
}
