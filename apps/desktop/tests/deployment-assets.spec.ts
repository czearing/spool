import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { test, expect } from "./project-fixture";

test("an already-open previous-build tab can open conversations and navigate to Runners after deployment", async ({ page, projectServer: server }) => {
  const previous = process.env.SPOOL_PREVIOUS_DIST;
  test.skip(!previous, "Set SPOOL_PREVIOUS_DIST to a retained production build for the deployment smoke test.");
  const task = { id: "deployment-chat", agent: "engineer", title: "Deployment conversation",
    prompt: "Preserve this conversation.", status: "completed", created_at: new Date().toISOString() };
  await writeFile(join(server.bohemia, "queues", "completed", `${task.id}.json`), JSON.stringify(task));
  await mkdir(join(server.bohemia, "logs"));
  await writeFile(join(server.bohemia, "logs", `${task.id}.log`), JSON.stringify({
    type: "assistant.message", timestamp: task.created_at, data: { content: "Reply survives deployment." },
  }) + "\n");
  const probe = createServer();
  await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("No test port assigned.");
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  const oldUrl = `http://127.0.0.1:${address.port}`;
  const child = spawn(process.execPath, [resolve("node_modules", "next", "dist", "bin", "next"),
    "start", "--hostname", "127.0.0.1", "--port", String(address.port)], {
    env: { ...process.env, NEXT_DIST_DIR: previous, SPOOL_PROJECTS_FILE: server.registry,
      SPOOL_RUNNERS_HOME: join(server.root, "runner-service"),
      SPOOL_RUNNERS_CONFIG: join(server.root, "runner-service", "spool-runners.json") },
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  let output = "", failure: Error | undefined;
  child.stdout.on("data", chunk => { output = (output + chunk).slice(-4096); });
  child.stderr.on("data", chunk => { output = (output + chunk).slice(-4096); });
  child.once("error", error => { failure = error; });
  try {
    await expect.poll(async () => {
      if (failure || child.exitCode !== null) throw new Error(`Previous build failed: ${failure ?? output}`);
      try { return (await fetch(oldUrl)).status; } catch { return 0; }
    }).toBe(200);
    let deployed = false;
    const missing: string[] = [], errors: string[] = [], lazy: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("response", response => {
      if (response.status() >= 400) missing.push(`${response.status()} ${new URL(response.url()).pathname}`);
      if (deployed && response.url().includes("/_next/static/")) lazy.push(response.url());
    });
    await page.route(`${server.url}/**`, async route => {
      if (deployed) { await route.continue(); return; }
      const url = new URL(route.request().url());
      await route.fulfill({ response: await route.fetch({ url: `${oldUrl}${url.pathname}${url.search}` }) });
    });
    await page.goto(`${server.url}/bohemia/tasks`);
    const card = page.getByRole("button", { name: "Open conversation: Deployment conversation" });
    await expect(card).toBeVisible();
    deployed = true;
    await card.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Reply survives deployment.", { exact: true })).toBeVisible();
    expect(lazy.length).toBeGreaterThan(0);
    await dialog.getByRole("button", { name: "Close dialog" }).click();
    await page.getByRole("link", { name: "Runners", exact: true }).click();
    await expect(page.getByRole("table", { name: "Runners", exact: true })).toContainText("No runners configured");
    expect(missing).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    if (child.pid && child.exitCode === null) { const exited = once(child, "exit"); child.kill(); await exited; }
  }
});
