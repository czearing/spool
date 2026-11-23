import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { once } from "node:events";

test("packaged updater snapshots its workflow without development fixtures", async () => {
  const { snapshotWorkflowSources } = await import(
    new URL("../src-tauri/resources/runners/bridge/updater-dispatch.mjs", import.meta.url));
  assert.doesNotThrow(snapshotWorkflowSources);
});

test("packaged repository gate includes its runtime scripts", { skip: process.platform !== "win32" }, () => {
  const gate = resolve(import.meta.dirname, "../src-tauri/resources/runners/packages/dedicated-runners/repo-gates/bohemia.ps1");
  const result = spawnSync("pwsh", ["-NoProfile", "-File", gate, "help"], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
});

test("packaged runner host survives backend exit, reconnects without duplication and drains explicitly", { timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "spool-integrated-runners-")), project = join(root, "project");
  const broken = join(root, "broken"), brokenRuntime = join(broken, ".runner", "automation");
  await mkdir(brokenRuntime, { recursive: true });
  await writeFile(join(brokenRuntime, "spool-runners.json"), "{invalid");
  for (const folder of ["agents", "queues/incoming", "queues/in_progress", "queues/completed", "queues/failed"])
    await mkdir(join(project, folder), { recursive: true });
  await writeFile(join(root, "projects.json"), JSON.stringify({ version: 1, projects: [
    { id: "broken", name: "Broken", root: broken }, { id: "fixture", name: "Fixture", root: project },
  ] }));
  let child, host, stopped = false, stderr = "";
  const script = process.env.SPOOL_TEST_BACKEND || resolve(import.meta.dirname, "../src-tauri/resources/backend.mjs");
  const engine = process.env.SPOOL_TEST_BINARY || resolve(import.meta.dirname, "../src-tauri/resources/spool-engine.exe");
  host = spawn(engine, ["runner-host", "--runtime", process.execPath, "--script", script, "--data", root], {
    cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  host.stderr.on("data", chunk => { stderr += chunk; });
  const hostExit = once(host, "exit");
  const start = async () => {
    stopped = false;
    child = spawn(process.execPath, [script], {
      cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
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
  t.after(async () => {
    await stop();
    if (host.exitCode === null) host.stdin.write("stop\n");
    await hostExit;
    await rm(root, { recursive: true, force: true });
  });
  const until = async check => {
    const deadline = Date.now() + 20000;
    while (!await check()) {
      if (Date.now() > deadline) throw new Error(`Runner timed out: ${stderr}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };
  let request = await start();
  await until(async () => {
    try { return JSON.parse(await readFile(join(brokenRuntime, "service.json"), "utf8")).state === "error"; }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
  });
  const started = performance.now();
  const page = await request("/api/desktop/page?path=/fixture");
  t.diagnostic(`Initial page: ${Math.round(performance.now() - started)} ms`);
  assert.equal(page.body.page.kind, "dashboard");
  assert.deepEqual(page.body.runners.runners, []);
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
  assert.equal(saved.status, 201, `${JSON.stringify(saved)}\n${stderr}`);
  const queued = await request(`${base}/runs`, "POST", { revision: saved.body.revision, input: {} });
  assert.equal(queued.status, 202, JSON.stringify(queued));
  await until(async () => { try { return (await readFile(join(project, "started.txt"), "utf8")).trim() === "started"; } catch (error) { if (error.code === "ENOENT") return false; throw error; } });
  const serviceFile = join(project, ".runner", "automation", "service.json");
  const servicePid = JSON.parse(await readFile(serviceFile, "utf8")).pid;
  await stop();
  assert.notEqual(JSON.parse(await readFile(serviceFile, "utf8")).state, "stopped");
  await until(async () => { try { return (await readFile(join(project, "finished.txt"), "utf8")).trim() === "finished"; } catch (error) { if (error.code === "ENOENT") return false; throw error; } });
  assert.equal((await readFile(join(project, "finished.txt"), "utf8")).trim(), "finished", "Shutdown must drain an active action.");
  const record = join(project, ".runner", "automation", "runners", workflow.id, ".runner", "executions", `${queued.body.id}.json`);
  await until(async () => JSON.parse(await readFile(record, "utf8")).status === "succeeded");
  assert.equal(JSON.parse(await readFile(record, "utf8")).status, "succeeded");
  request = await start();
  const duplicate = spawn(engine, ["runner-host", "--runtime", process.execPath, "--script", script, "--data", root], {
    cwd: root, windowsHide: true, stdio: "ignore",
  });
  assert.equal((await once(duplicate, "exit"))[0], 0);
  assert.equal(JSON.parse(await readFile(serviceFile, "utf8")).pid, servicePid);
  const history = await request(`${base}/runs`);
  assert.equal(history.body.length, 1);
  assert.equal(history.body[0].status, "succeeded");
  const snapshot = await request("/api/projects/fixture/runners");
  assert.equal(snapshot.body.runners[0]?.id, workflow.id, JSON.stringify(snapshot));
  assert.equal((await request("/api/desktop/page?path=/fixture/runners/native-check")).body.page.kind, "runner");
  const output = await request(`${base}/output?run=${queued.body.id}`);
  assert.equal(output.status, 200);
  assert.equal(output.body.runs[0].status, "succeeded");
  assert.match(output.body.output, /succeeded/);
  host.stdin.write("stop\n");
  assert.equal((await hostExit)[0], 0, stderr);
  assert.equal(JSON.parse(await readFile(serviceFile, "utf8")).state, "stopped");
});
