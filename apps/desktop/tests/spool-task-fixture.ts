import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test as base, expect } from "./project-fixture";

export { expect };
export const test = base.extend<{ scheduler: { restart: () => Promise<void> }; interactive: boolean }>({
  interactive: [false, { option: true }],
  scheduler: async ({ projectServer: server, interactive }, use) => {
    const binary = process.env.SPOOL_TEST_BINARY ?? resolve("..", "spool", "target", "release", process.platform === "win32" ? "spool.exe" : "spool");
    await access(binary);
    const paused = join(server.bohemia, "controls", "paused"), bin = join(server.root, "stub-bin");
    await mkdir(paused, { recursive: true }); await mkdir(bin);
    for (const file of await readdir(join(server.bohemia, "agents"))) {
      if (file.endsWith(".md")) await writeFile(join(paused, file.slice(0, -3)), "Fixture: no real agent execution.");
    }
    for (const queue of ["incoming", "in_progress", "completed", "failed"]) {
      for (const file of await readdir(join(server.bohemia, "queues", queue))) {
        const path = join(server.bohemia, "queues", queue, file), task = JSON.parse(await readFile(path, "utf8"));
        await writeFile(path, JSON.stringify({ ...task, agent: task.agent ?? "engineer" }));
      }
    }
    const stub = resolve("tests", interactive ? "spool-chat-stub.mjs" : "spool-agent-stub.mjs");
    if (process.platform === "win32") {
      await copyFile(process.execPath, join(bin, "node.exe"));
      const loader = join(bin, "node_modules", "@github", "copilot"); await mkdir(loader, { recursive: true });
      await writeFile(join(loader, "npm-loader.js"), `import(${JSON.stringify(pathToFileURL(stub).href)}).catch(error => { console.error(error); process.exitCode = 1; });`);
    } else await writeFile(join(bin, "copilot"), `#!${process.execPath}\nawait import(${JSON.stringify(stub)});\n`, { mode: 0o755 });
    const env = { ...process.env, SPOOL_INTERACTIVE_ACP: interactive ? "1" : "0",
      SPOOL_COPILOT_SESSION_ROOT: join(server.root, "sessions"), SPOOL_FIXTURE_CALL: join(server.root, "agent-call.json") };
    for (const key of Object.keys(env)) if (key.toLowerCase() === "path") Reflect.deleteProperty(env, key);
    const systemPath = process.platform === "win32"
      ? join(process.env.ProgramFiles ?? "C:\\Program Files", "PowerShell", "7") : "/usr/bin:/bin";
    const start = () => spawn(binary, ["--root", server.bohemia, "daemon"], {
      cwd: server.bohemia, env: { ...env, PATH: bin + delimiter + systemPath }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    let child = start();
    const ready = async () => {
      let output = "", bootError = "";
      child.once("error", (error) => { bootError = error.message; });
      child.stdout!.on("data", (chunk) => { output = (output + chunk).slice(-8192); });
      child.stderr!.on("data", (chunk) => { output = (output + chunk).slice(-8192); });
      await expect.poll(async () => {
        if (bootError || child.exitCode !== null) throw new Error(`Fixture daemon exited: ${bootError}\n${output}`);
        try {
          const capability = JSON.parse(await readFile(join(server.bohemia, "controls", "capabilities.json"), "utf8"));
          return capability.taskControl && capability.pid === child.pid;
        }
        catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return false; throw error; }
      }, { timeout: 15000 }).toBe(true);
    };
    const stop = async () => {
      if (child.pid && child.exitCode === null) { const exited = once(child, "exit"); child.kill(); await exited; }
    };
    try {
      await ready();
      await use({ restart: async () => {
        expect(await readdir(join(server.bohemia, "queues", "in_progress"))).toEqual([]);
        await stop(); child = start(); await ready();
      } });
      await expect.poll(() => readdir(join(server.bohemia, "queues", "in_progress")), { timeout: 15000 }).toEqual([]);
    } finally {
      await stop();
    }
  },
});
