import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

test("Vite serves the canonical backend and reloads route additions, changes and removals", { timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "spool-web-"));
  const route = `__dev-test-${randomUUID()}`, source = resolve(import.meta.dirname, "../src/app/api", route);
  const previous = { ...process.env };
  process.env.SPOOL_DATA_DIR = root;
  await writeFile(join(root, "connections.json"), JSON.stringify({
    SPOOL_PROJECTS_FILE: join(root, "projects.json"), SPOOL_RUNNERS_HOME: join(root, "runners"),
    SPOOL_RUNNERS_CONFIG: join(root, "runners", "missing.json"),
  }));
  await writeFile(join(root, "projects.json"), JSON.stringify({ version: 1, projects: [] }));
  for (const folder of ["agents", "queues/incoming", "queues/in_progress", "queues/completed", "queues/failed"]) {
    await mkdir(join(root, folder), { recursive: true });
  }
  let server;
  t.after(async () => {
    await server?.close();
    await rm(source, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  });
  server = await createServer({ root: resolve(import.meta.dirname, ".."), server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const request = (path, options) => fetch(`${origin}${path}`, options);
  assert.match(await (await request("/")).text(), /src\/desktop\/main\.tsx/);
  assert.deepEqual((await (await request("/api/desktop/page")).json()).page, { kind: "setup" });
  assert.equal((await request("/api/unknown")).status, 404);
  assert.equal((await request("/api/projects", { method: "DELETE", headers: { Origin: origin } })).status, 405);
  const created = await request("/api/projects", { method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ name: "Fixture", root }) });
  assert.equal(created.status, 201);
  const project = await created.json();
  assert.equal((await (await request("/api/desktop/page")).json()).redirect, `/${project.id}`);
  const live = await request(`/api/projects/${project.id}/live`);
  assert.equal(live.status, 200);
  const controller = new AbortController();
  const stream = await request(`/api/projects/${project.id}/runners`, { signal: controller.signal, headers: { Accept: "text/event-stream" } });
  assert.equal(stream.status, 200);
  assert.equal(stream.headers.get("content-type"), "text/event-stream");
  assert.match(new TextDecoder().decode((await stream.body.getReader().read()).value), /"configured":false/);
  controller.abort();
  await mkdir(source);
  const update = value => writeFile(join(source, "route.ts"), `export const GET = () => Response.json({ value: ${value} });\n`);
  const waitFor = async predicate => {
    for (let attempt = 0; attempt < 60; attempt++) {
      if (await predicate()) return;
      await delay(100);
    }
    assert.fail("Backend source change was not reflected without restarting Vite");
  };
  await update(1);
  await waitFor(async () => { const response = await request(`/api/${route}`); return response.ok && (await response.json()).value === 1; });
  await update(2);
  await waitFor(async () => (await (await request(`/api/${route}`)).json()).value === 2);
  await rm(source, { recursive: true });
  await waitFor(async () => (await request(`/api/${route}`)).status === 404);
});
