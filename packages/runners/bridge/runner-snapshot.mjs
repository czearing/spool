import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agents, keyFor, readConfiguration } from "./config.mjs";
import { runnerStates } from "./health.mjs";
import { runnerDetails } from "./runner-details.mjs";
import { runnerNames, runnerSetting } from "./workflow-store.mjs";
import { runtimeRoot } from "./runtime-root.mjs";

const samePath = (a, b) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
export async function runnerSnapshot(config, projectRoot, root = path.join(runtimeRoot(), "runners")) {
  if (typeof config.spool_dir !== "string" || !path.isAbsolute(config.spool_dir)) throw new Error("Invalid runner Spool directory.");
  const configured = samePath(realpathSync(config.spool_dir), realpathSync(projectRoot));
  if (!configured) return { checkedAt: new Date().toISOString(), configured: false, runners: [] };
  const names = runnerNames(config);
  for (const name of names) {
    const setting = runnerSetting(config, name);
    if (!setting || typeof setting !== "object" || setting.enabled !== undefined && typeof setting.enabled !== "boolean") {
      throw new Error(`Invalid runner settings: ${name}`);
    }
  }
  const rows = await runnerStates(names, root);
  return { checkedAt: new Date().toISOString(), configured: true, runners: rows.map(row => ({
    id: row.runner, name: runnerSetting(config, row.runner).editor?.name || runnerSetting(config, row.runner).name || row.runner,
    enabled: runnerSetting(config, row.runner).enabled === true,
    connected: row.connected, running: row.running, healthy: row.healthy, stopping: row.stopping,
    phase: row.phase, lastRunAt: row.lastAttempt ?? null, lastSuccessAt: row.lastScan ?? null,
    lastRunFailed: !!row.lastError,
    ...runnerDetails(row, runnerSetting(config, row.runner), path.join(root, row.runner, ".runner")),
  })) };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = readConfiguration(process.argv[2]);
  if (process.env.SPOOL_DIR) config.spool_dir = process.env.SPOOL_DIR;
  console.log(JSON.stringify(await runnerSnapshot(config, process.argv[3])));
}
