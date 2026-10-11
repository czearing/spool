import { spawn } from "node:child_process";
import path from "node:path";
import { runnerNames, runnerSetting } from "./workflow-store.mjs";
import { readConfiguration } from "./config.mjs";
import { runtimeRoot } from "./runtime-root.mjs";

const config = process.env.SPOOL_RUNNER_CONFIG ? JSON.parse(process.env.SPOOL_RUNNER_CONFIG) : readConfiguration(process.argv[2]);
const selected = runnerNames(config).filter(id => runnerSetting(config, id).enabled && (!process.argv[3] || id === process.argv[3].toLowerCase()));
if (!selected.length) throw new Error("No enabled runner matches the selection.");
let failed = false;
for (const id of selected) {
  const child = spawn(config.node_binary || process.execPath, [path.join(runtimeRoot(), "runners", id, "run.mjs"), "--once"], {
    windowsHide: true, stdio: ["pipe", "inherit", "inherit"], env: { ...process.env, SPOOL_RUNNER_CONFIG: JSON.stringify(config) },
  });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", code => { if (code !== 0) failed = true; resolve(); });
  });
}
if (failed) process.exitCode = 1;
