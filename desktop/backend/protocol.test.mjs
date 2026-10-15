import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";

test("installer includes the native CLI used by the packaged backend", () => {
  const config = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
  assert.ok(config.bundle.resources.includes("resources/native/"));
  const executable = process.platform === "win32" ? "spool.exe" : "spool";
  assert.ok(readFileSync(new URL(`../src-tauri/resources/native/${executable}`, import.meta.url)).length > 0);
});

test("packaged backend reads local projects, edits agent settings, and shuts down with its parent", async t => {
  const root = mkdtempSync(path.join(tmpdir(), "spool desktop "));
  for (const folder of ["agents", "queues/incoming", "queues/in_progress", "queues/completed", "queues/failed"]) {
    mkdirSync(path.join(root, folder), { recursive: true });
  }
  writeFileSync(path.join(root, "projects.json"), JSON.stringify({ version: 1, projects: [] }));
  const env = { ...process.env, SPOOL_DATA_DIR: root, SPOOL_PROJECTS_FILE: path.join(root, "projects.json") };
  delete env.SPOOL_AGENT_BINARY;
  const child = spawn(process.execPath, [path.resolve(import.meta.dirname, "../src-tauri/resources/backend.mjs")], {
    cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    env,
  });
  let stderr = ""; child.stderr.on("data", chunk => { stderr += chunk; });
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
  t.after(async () => {
    child.stdin.end();
    await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once("exit", resolve); });
    rmSync(root, { recursive: true, force: true });
  });
  await ready;
  const request = (url, method = "GET", body) => new Promise((resolve, reject) => {
    const id = randomUUID(), frames = [];
    const timeout = setTimeout(() => reject(new Error(`Request timed out: ${stderr}`)), 10000);
    waiting.set(id, frame => {
      frames.push(frame);
      if (frame.type === "end" || frame.type === "error") {
        clearTimeout(timeout); waiting.delete(id);
        const content = frames.filter(value => value.type === "chunk").map(value => Buffer.from(value.body, "base64").toString()).join("");
        resolve({ status: frames[0].status, body: content ? JSON.parse(content) : null, error: frame.error });
      }
    });
    child.stdin.write(JSON.stringify({ id, url, method, headers: [["content-type", "application/json"]], body }) + "\n");
  });
  assert.deepEqual((await request("/api/desktop/page")).body.page, { kind: "setup" });
  assert.equal((await request("/api/does-not-exist")).status, 404);
  assert.equal((await request("/api/projects", "DELETE")).status, 405);
  const result = await request("/api/projects", "POST", JSON.stringify({ name: "Fixture" }));
  assert.equal(result.status, 201, JSON.stringify(result));
  assert.equal((await request("/api/desktop/page")).body.redirect, `/${result.body.id}`);
  const library = await request("/api/projects", "POST", JSON.stringify({ name: "Library" }));
  assert.equal(library.status, 201);
  const projects = JSON.parse(readFileSync(path.join(root, "projects.json"), "utf8")).projects;
  const projectRoot = projects.find(project => project.id === result.body.id).root;
  const agents = `/api/projects/${result.body.id}/agents`;
  const created = await request(agents, "POST", JSON.stringify({ name: "researcher", prompt: "# Keep this prompt\n",
    model: null, image: null, max_concurrent_runs: 1 }));
  assert.equal(created.status, 201, JSON.stringify(created));
  const settings = `${agents}/researcher/settings`;
  const initial = await request(settings);
  assert.equal(initial.status, 200, JSON.stringify(initial));
  assert.equal(initial.body.name, "researcher");
  assert.equal(initial.body.maxConcurrentRuns, 1);
  const updated = await request(settings, "PUT", JSON.stringify({ revision: initial.body.revision,
    model: null, description: "Packaged settings", max_concurrent_runs: 2 }));
  assert.equal(updated.status, 200, JSON.stringify(updated));
  assert.equal(updated.body.maxConcurrentRuns, 2);
  assert.equal((await request(settings)).body.description, "Packaged settings");
  assert.match(readFileSync(path.join(projectRoot, "agents", "researcher.md"), "utf8"), /# Keep this prompt/);
  assert.equal((await request(settings, "PUT", JSON.stringify({ revision: initial.body.revision,
    model: null, max_concurrent_runs: 2, description: "Stale change" }))).status, 409);
  writeFileSync(path.join(projects.find(project => project.id === library.body.id).root, "agents", "designer.md"), "# Shared designer");
  const source = `/api/projects/${library.body.id}/agents/designer`;
  const target = `/api/projects/${result.body.id}/agents/designer`;
  const preview = await request(source);
  assert.equal(preview.status, 200);
  const imported = await request(`/api/projects/${result.body.id}/agent-import`, "POST", JSON.stringify({
    name: "designer", sourceProject: library.body.id, sourceAgent: "designer",
    revision: preview.body.revision, context: "Only this project's workspace.",
  }));
  assert.equal(imported.status, 201, JSON.stringify(imported));
  assert.equal((await request(target)).body.prompt, "# Shared designer");
  assert.match((await request(`${target}?scope=context`)).body.prompt, /Only this project's workspace/);
  const saved = await request(source, "PUT", JSON.stringify({ ...preview.body, prompt: "Updated shared designer" }));
  assert.equal(saved.status, 200);
  assert.equal((await request(target)).body.prompt, "Updated shared designer");
  assert.equal((await request(source, "DELETE")).status, 409);
  assert.equal((await request(`https://example.com`)).error, "Invalid desktop operation.");
});
