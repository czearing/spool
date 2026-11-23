import { createHash } from "node:crypto";
import { mkdir, realpath, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { test as base, expect } from "./project-fixture";

export { expect };
export const test = base.extend<{ runnerService: { mismatch: () => Promise<void>; invalidate: () => Promise<void>;
  setPhase: (phase: "scanning" | "ready") => Promise<void>; lastRun: string; lastSuccess: string; lastRepositoryUpdate: string;
  setRunners: (runners: Record<string, { enabled: boolean }>) => Promise<void> } }>({
  runnerService: async ({ projectServer: project }, use) => {
    const home = join(project.root, "runner-service"), runners = join(home, "runners");
    const directory = join(runners, "livesite"), runtime = join(directory, ".runner");
    await mkdir(runtime, { recursive: true }); await mkdir(join(home, "bridge"));
    await writeFile(join(directory, "run.mjs"), "");
    const setRunners = async (settings: Record<string, { enabled: boolean }>) => {
      const config = join(home, "spool-runners.json");
      await writeFile(`${config}.tmp`, JSON.stringify({ spool_dir: project.bohemia, ...settings }));
      await rename(`${config}.tmp`, config);
    };
    await setRunners({ livesite: { enabled: true }, pr_updater: { enabled: false } });
    const module = pathToFileURL(resolve("..", "spool-runners", "bridge", "runner-snapshot.mjs")).href;
    await writeFile(join(home, "bridge", "runner-snapshot.mjs"), `
      import { readFileSync } from "node:fs";
      import { runnerSnapshot } from ${JSON.stringify(module)};
      console.log(JSON.stringify(await runnerSnapshot(JSON.parse(readFileSync(process.argv[2], "utf8")),
        process.argv[3], ${JSON.stringify(runners)})));
    `);
    const lastRun = "2026-10-03T00:14:00Z", lastSuccess = "2026-10-01T08:00:00Z";
    const record = { pid: process.pid, instanceId: "fixture-runner", phase: "degraded", pollSeconds: 60,
      lastScan: lastSuccess, lastAttempt: lastRun, lastError: "Dependency installation failed PRIVATE_RUNNER_ERROR", secret: "PRIVATE_TOKEN" };
    await writeFile(join(runtime, "status.json"), JSON.stringify(record));
    await writeFile(join(runtime, "pid.json"), JSON.stringify(record));
    const writeStatus = async () => {
      const file = join(runtime, "status.json");
      await writeFile(`${file}.tmp`, JSON.stringify(record));
      await rename(`${file}.tmp`, file);
    };
    const lastRepositoryUpdate = "2026-10-02T20:00:00Z";
    await writeFile(join(runtime, "repository-refresh.json"), JSON.stringify({
      version: 1, pid: process.pid, instanceId: "fixture-runner", state: "failed",
      lastAttemptAt: lastRun, lastUpdatedAt: lastRepositoryUpdate,
      error: "Dependency installation failed. Check the local preparation log.",
    }));
    const physical = await realpath(directory), key = process.platform === "win32" ? physical.toLowerCase() : physical;
    const name = `bohemia-runner-${createHash("sha256").update(key).digest("hex").slice(0, 32)}`;
    const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\${name}` :
      process.platform === "linux" ? `\0${name}` : join(tmpdir(), `${name}.sock`);
    let identity = "fixture-runner";
    const server = createServer(socket => socket.on("data", () => socket.end(JSON.stringify({
      pid: process.pid, instanceId: identity, stopping: false,
    }))));
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(endpoint, resolve); });
    try { await use({
      mismatch: async () => { identity = "different-process"; await writeStatus(); },
      invalidate: () => writeFile(join(home, "spool-runners.json"), "invalid configuration"),
      setPhase: async phase => {
        record.phase = phase; record.lastError = ""; record.lastScan = new Date().toISOString();
        record.lastAttempt = record.lastScan;
        await writeStatus();
      },
      lastRun, lastSuccess, lastRepositoryUpdate, setRunners,
    }); }
    finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  },
});
