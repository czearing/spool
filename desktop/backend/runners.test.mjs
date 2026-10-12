import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { once } from "node:events";

test("packaged repository gate includes its runtime scripts", { skip: process.platform !== "win32" }, () => {
  const gate = resolve(import.meta.dirname, "../src-tauri/resources/runners/packages/dedicated-runners/repo-gates/bohemia.ps1");
  const result = spawnSync("pwsh", ["-NoProfile", "-File", gate, "help"], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
});

test("packaged application starts, executes and drains runners without an external installation", { timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "spool-integrated-runners-")), project = join(root, "project");
  const broken = join(root, "broken"), brokenRuntime = join(broken, ".runner", "automation");
  await mkdir(brokenRuntime, { recursive: true });
  await writeFile(join(brokenRuntime, "spool-runners.json"), "{invalid");
  for (const folder of ["agents", "queues/incoming", "queues/in_progress", "queues/completed", "queues/failed"])
    await mkdir(join(project, folder), { recursive: true });
  await writeFile(join(root, "projects.json"), JSON.stringify({ version: 1, projects: [
    { id: "broken", name: "Broken", root: broken }, { id: "fixture", name: "Fixture", root: project },
  ] }));
  let child, stopped = false, stderr = "";
  const start = async () => {
    stopped = false;
    child = spawn(process.execPath, [resolve(import.meta.dirname, "../src-tauri/resources/backend.mjs")], {
      cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, SPOOL_DATA_DIR: root, SPOOL_PROJECTS_FILE: join(root, "projects.json"),
        SPOOL_RUNNERS_HOME: join(root, "does-not-exist"), SPOOL_RUNNERS_CONFIG: join(root, "missing.json") },
    });
    child.stderr.on("data", chunk => { stderr += chunk; });
    const waiting = new Map();
    const ready = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", code => reject(new Error(`Backend exited ${code}: ${stderr}`)));
      createInterface({ input: child.stdout }).on("line", line => {
        const frame = JSON.parse(line);
        if (frame.id === "ready") return resolve();
        waiting.get(frame.id)?.(frame);
      });
    });
    await ready;
    return (url, method = "GET", body) => new Promise((resolve, reject) => {
      const id = randomUUID(), frames = [], timer = setTimeout(() => reject(new Error(`Request timed out: ${stderr}`)), 15000);
      waiting.set(id, frame => {
        frames.push(frame);
        if (["end", "error"].includes(frame.type)) {
          clearTimeout(timer); waiting.delete(id);
          const content = frames.filter(value => value.type === "chunk").map(value => Buffer.from(value.body, "base64").toString()).join("");
          resolve({ status: frames[0].status, body: content ? JSON.parse(content) : null, error: frame.error });
        }
      });
      child.stdin.write(JSON.stringify({ id, url, method, headers: [["content-type", "application/json"]], body: body && JSON.stringify(body) }) + "\n");
    });
  };
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    const exit = once(child, "exit"); child.stdin.end(); await exit;
  };
  t.after(async () => { await stop(); await rm(root, { recursive: true, force: true }); });
  const until = async check => {
    const deadline = Date.now() + 20000;
    while (!await check()) {
      if (Date.now() > deadline) throw new Error(`Runner timed out: ${stderr}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };
  let request = await start();
  assert.equal(JSON.parse(await readFile(join(brokenRuntime, "service.json"), "utf8")).state, "error");
  const started = performance.now();
  const page = await request("/api/desktop/page?path=/fixture");
  t.diagnostic(`Initial page and runner catalog: ${Math.round(performance.now() - started)} ms`);
  assert.deepEqual(page.body.runners, { configured: true, runners: [] });
  assert.equal((await request("/api/desktop/page?path=/fixture/runners")).body.redirect, "/fixture");
  await writeFile(join(brokenRuntime, "spool-runners.json"), JSON.stringify({ spool_dir: broken, custom_runners: {} }));
  await until(async () => JSON.parse(await readFile(join(brokenRuntime, "service.json"), "utf8")).state === "running");
  const workflow = { id: "native-check", name: "Native check", kind: "custom", enabled: false, workspace: project, intervalSeconds: 300,
    revision: "", nodes: [{ id: "trigger", kind: "manual", label: "Manual", position: { x: 0, y: 0 } },
      { id: "action", kind: "command", label: "Action", position: { x: 224, y: 0 },
        command: "Set-Content started.txt 'started'; Start-Sleep -Seconds 2; Set-Content finished.txt 'finished'" }],
    edges: [{ id: "edge", source: "trigger", target: "action" }] };
  const base = "/api/projects/fixture/runners/native-check";
  const saved = await request(base, "POST", workflow);
  assert.equal(saved.status, 201, JSON.stringify(saved));
  const queued = await request(`${base}/runs`, "POST", { revision: saved.body.revision, input: {} });
  assert.equal(queued.status, 202, JSON.stringify(queued));
  await until(async () => { try { return (await readFile(join(project, "started.txt"), "utf8")).trim() === "started"; } catch (error) { if (error.code === "ENOENT") return false; throw error; } });
  await stop();
  assert.equal(JSON.parse(await readFile(join(project, ".runner", "automation", "service.json"), "utf8")).state, "stopped");
  assert.equal((await readFile(join(project, "finished.txt"), "utf8")).trim(), "finished", "Shutdown must drain an active action.");
  const record = join(project, ".runner", "automation", "runners", workflow.id, ".runner", "executions", `${queued.body.id}.json`);
  assert.equal(JSON.parse(await readFile(record, "utf8")).status, "succeeded");
  request = await start();
  const history = await request(`${base}/runs`);
  assert.equal(history.body.length, 1);
  assert.equal(history.body[0].status, "succeeded");
  assert.equal((await request("/api/desktop/page?path=/fixture")).body.runners.runners[0].id, workflow.id);
});
