import assert from "node:assert/strict";
import test from "node:test";
import { chromium, expect } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startProductionApp } from "./production-app.mjs";

test("the disabled runners flight hides navigation and denies all runner operations despite saved configuration", { timeout: 90000 }, async t => {
  const previous = process.env.SPOOL_ENABLE_RUNNERS;
  delete process.env.SPOOL_ENABLE_RUNNERS;
  const root = await mkdtemp(join(tmpdir(), "spool-runner-flight-")), project = join(root, "project");
  const automation = join(project, ".runner", "automation"), config = join(automation, "spool-runners.json");
  const saved = JSON.stringify({ spool_dir: project, livesite: { enabled: true } });
  let server, browser;
  t.after(async () => {
    await browser?.close(); await server?.close(); await rm(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.SPOOL_ENABLE_RUNNERS;
    else process.env.SPOOL_ENABLE_RUNNERS = previous;
  });
  for (const folder of ["agents", "queues/incoming", "queues/in_progress", "queues/completed", "queues/failed"])
    await mkdir(join(project, folder), { recursive: true });
  await mkdir(automation, { recursive: true });
  await writeFile(config, saved);
  await writeFile(join(root, "projects.json"), JSON.stringify({ version: 1,
    projects: [{ id: "fixture", name: "Fixture", root: project }] }));
  server = await startProductionApp(root);
  const base = `${server.url}/api/projects/fixture/runners`;
  const pageUrl = `${server.url}/api/desktop/page?path=`;
  for (const value of [undefined, "0", "true"]) {
    if (value === undefined) delete process.env.SPOOL_ENABLE_RUNNERS;
    else process.env.SPOOL_ENABLE_RUNNERS = value;
    const response = await fetch(`${pageUrl}/fixture`), data = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(data.flights, { runners: false });
    assert.equal(data.runners, undefined);
    assert.equal((await fetch(`${pageUrl}/fixture/runners/livesite`)).status, 404);
    for (const path of ["", "/livesite", "/livesite/runs", "/livesite/output"])
      for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"])
        assert.equal((await fetch(`${base}${path}`, { method, headers: { Origin: server.url } })).status, 404);
    assert.equal((await fetch(base, { headers: { Accept: "text/event-stream" } })).status, 404);
  }
  delete process.env.SPOOL_ENABLE_RUNNERS;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage(), requests = [], errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (request.url().startsWith(base)) requests.push(request.url()); });
  await page.goto(`${server.url}/#/fixture/tasks`);
  const navigation = page.getByRole("navigation", { name: "Project navigation", exact: true });
  await expect(navigation.getByRole("link", { name: "Tasks", exact: true })).toBeVisible();
  await expect(navigation.getByRole("button", { name: /^Runners/ })).toHaveCount(0);
  assert.deepEqual(requests, [], "Disabled runners must not subscribe to status or catalog streams.");
  assert.deepEqual(errors, []);
  assert.equal(await readFile(config, "utf8"), saved, "A flight must not rewrite saved runner configuration.");
  process.env.SPOOL_ENABLE_RUNNERS = "1";
  const enabled = await (await fetch(`${pageUrl}/fixture`)).json();
  assert.deepEqual(enabled.flights, { runners: true });
  assert.deepEqual(enabled.runners.runners.map(runner => runner.id), ["livesite"]);
});
