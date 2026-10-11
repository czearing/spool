import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readRunnerState, runnerEndpoint } from "../packages/bohemia-agent-tooling/src/index.js";
import { agents } from "./config.mjs";
import { validId } from "./workflow-schema.mjs";
import { runtimeRoot } from "./runtime-root.mjs";

function probe(entry) {
  return new Promise(resolve => {
    const socket = net.createConnection(runnerEndpoint(entry));
    let text = "";
    const finish = value => { socket.destroy(); resolve(value); };
    socket.setEncoding("utf8");
    socket.setTimeout(5000, () => finish(null));
    socket.once("error", () => finish(null));
    socket.once("connect", () => socket.end('{"action":"status"}\n'));
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
    const identity = state.running ? await probe(entry) : null;
    const owned = identity?.pid === state.pid && typeof identity?.instanceId === "string" &&
      !!identity.instanceId && identity.instanceId === state.status?.instanceId;
    const healthReason = !state.running ? "Runner process is not running"
      : state.lastError ? state.lastError
      : state.stale && !preparing ? `No completed scan within the freshness budget; current phase: ${state.phase}`
      : !owned ? "Live control-pipe identity could not be confirmed"
      : identity.stopping ? "Runner is draining its current scan"
      : preparing ? `Preparation active: ${state.status.preparation.message || state.status.preparation.operation}; last completed scan is unchanged` : null;
    return { ...state.status, runner: name, pid: state.pid, running: state.running,
      connected: owned, stopping: owned && identity.stopping === true,
      phase: state.phase || "not_started", lastError: state.lastError,
      healthReason,
      healthy: !!((state.ready || preparing) && !state.lastError && owned && !identity.stopping) };
  }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await runnerStates(process.argv.slice(2))));
}
