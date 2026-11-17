import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readRunnerState, runnerEndpoint } from "../packages/bohemia-agent-tooling/src/index.js";
import { agents } from "./config.mjs";
import { validId } from "./workflow-schema.mjs";
import { runtimeRoot } from "./runtime-root.mjs";

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function probe(entry) {
  return new Promise(resolve => {
    const socket = net.createConnection(runnerEndpoint(entry));
    let text = "";
    const finish = value => { socket.destroy(); resolve(value); };
    socket.setEncoding("utf8");
    socket.setTimeout(5000, () => finish(null));
    socket.once("error", () => finish(null));
    socket.once("connect", () => socket.write('{"action":"status"}\n'));
    socket.on("data", chunk => {
      text += chunk;
      if (text.length > 4096) finish(null);
    });
    socket.once("end", () => {
      try { finish(JSON.parse(text)); } catch { finish(null); }
    });
  });
}

export async function runnerStates(names, root = path.join(runtimeRoot(), "runners")) {
  return Promise.all(names.map(async name => {
    if (!Object.hasOwn(agents, name) && !validId(name)) throw new Error(`Unknown runner: ${name}`);
    const directory = path.join(root, name), entry = path.join(directory, "run.mjs");
    const state = readRunnerState({ name, directory, entry });
    const progressAge = Date.now() - Date.parse(state.status?.preparation?.progressAt || "");
    const preparing = state.phase === "scanning" && progressAge >= 0 && progressAge < 120_000;
    const preparation = state.status?.preparation;
    const preparationAge = Date.now() - Date.parse(preparation?.startedAt || "");
    // Canonical commands own their deadlines; quiet output alone is not a stalled runner.
    const preparingProcess = state.phase === "scanning" &&
      ["bohemia_prepare", "bohemia_build", "bohemia_check"].includes(preparation?.operation) &&
      preparationAge >= 0 && preparationAge < 5_400_000 && preparation.pid !== state.pid && processAlive(preparation.pid);
    const scanProgress = state.status?.scanProgress;
    const scanAge = Date.now() - Date.parse(scanProgress?.progressAt || "");
    const scanningFiles = state.phase === "scanning" && Number.isSafeInteger(scanProgress?.filesScanned) &&
      scanProgress.filesScanned >= 0 && typeof scanProgress.currentFile === "string" &&
      !!scanProgress.currentFile && scanAge >= 0 && scanAge < 120_000;
    const publication = state.status?.publicationProgress;
    const publicationAge = Date.now() - Date.parse(publication?.progressAt || "");
    const publishingFiles = state.phase === "scanning" && ["planning", "validating"].includes(publication?.stage) &&
      Number.isSafeInteger(publication.filesProcessed) && publication.filesProcessed >= 0 &&
      typeof publication.currentFile === "string" && !!publication.currentFile &&
      publicationAge >= 0 && publicationAge < 120_000;
    const identity = state.running ? await probe(entry) : null;
    const owned = identity?.pid === state.pid && typeof identity?.instanceId === "string" &&
      !!identity.instanceId && identity.instanceId === state.status?.instanceId;
    const healthReason = !state.running ? "Runner process is not running"
      : state.lastError ? state.lastError
      : state.stale && !preparing && !preparingProcess && !scanningFiles && !publishingFiles ? `No completed scan within the freshness budget; current phase: ${state.phase}`
      : !owned ? "Live control-pipe identity could not be confirmed"
      : identity.stopping ? "Runner is draining its current scan"
      : preparingProcess ? `Repository subprocess ${preparation.pid} is running; last completed scan is unchanged`
      : preparing ? `Preparation active: ${state.status.preparation.message || state.status.preparation.operation}; last completed scan is unchanged`
      : scanningFiles ? `File scan active: ${scanProgress.currentFile}; last completed scan is unchanged`
      : publishingFiles ? `Publication ${publication.stage} active: ${publication.currentFile}; last completed scan is unchanged` : null;
    return { ...state.status, runner: name, pid: state.pid, running: state.running,
      connected: owned, stopping: owned && identity.stopping === true,
      phase: state.phase || "not_started", lastError: state.lastError,
      healthReason,
      healthy: !!((state.ready || preparing || preparingProcess || scanningFiles || publishingFiles) && !state.lastError && owned && !identity.stopping) };
  }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await runnerStates(process.argv.slice(2))));
}
