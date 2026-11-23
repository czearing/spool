import { realpath } from "node:fs/promises";
import path from "node:path";
import { acquireProcessLock } from "../packages/bohemia-agent-tooling/src/process-lock.js";
import { startApplicationRunners } from "./application.mjs";

export async function startRunnerService(registry) {
  const directory = await realpath(path.dirname(registry));
  const identity = path.join(directory, path.basename(registry));
  let release;
  try {
    release = await acquireProcessLock(process.platform === "win32" ? identity.toLowerCase() : identity,
      { namespace: "runner-service" });
  } catch (error) { if (error.code === "EADDRINUSE") return null; throw error; }
  try {
    const runners = await startApplicationRunners(registry);
    let shutdown;
    return { stop: () => shutdown ??= (async () => { try { await runners.stop(); } finally { await release(); } })() };
  } catch (error) { await release(); throw error; }
}
