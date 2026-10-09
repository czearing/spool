import { test as base, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type ProjectServer = { url: string; root: string; registry: string; bohemia: string; bookCook: string; empty: string; restart: () => Promise<void> };
export { expect };
export const costValue = (page: Page, label: string) => page.getByRole("table", { name: "Cost by agent data", exact: true })
  .getByRole("row").filter({ has: page.getByRole("rowheader", { name: label, exact: true }) }).getByRole("cell");
export const workItemTotal = (page: Page) => page.getByRole("status").filter({ hasText: /^\d+ work items$/ });
export async function writeUsage(root: string, records: { id: string; startedAt: string; endedAt: string; costUsd: number; agent: string | null }[]) {
  await mkdir(join(root, "usage"), { recursive: true });
  await writeFile(join(root, "usage", "accounting.json"), JSON.stringify({
    version: 2, unit: "model_tokens", currency: "USD", unavailableTasks: [],
    sessions: { fixture: { records: records.map((row) => ({ ...row, model: "gpt-6-astra",
      tokens: { uncachedInputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 } })), error: null } },
  }));
}
export const test = base.extend<{ projectServer: ProjectServer }>({
  projectServer: async ({}, use) => {
    const root = await mkdtemp(join(tmpdir(), "spool-project-ui-"));
    const registry = join(root, "projects.json"), bohemia = join(root, "bohemia"), bookCook = join(root, "book-cook"), empty = join(root, "empty");
    const probe = createServer();
    await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
    const address = probe.address();
    if (!address || typeof address === "string") throw new Error("No test port assigned.");
    await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
    const url = `http://127.0.0.1:${address.port}`;
    for (const source of [bohemia, bookCook, empty]) {
      await Promise.all(["incoming", "in_progress", "completed", "failed"].map((status) => mkdir(join(source, "queues", status), { recursive: true })));
    }
    await mkdir(join(bohemia, "agents")); await mkdir(join(bookCook, "agents"));
    await writeFile(join(bohemia, "agents", "engineer.md"), "---\r\nmodel: unchanged-model\r\ndescription: Fixture engineer\r\n---\r\n# Engineer\r\n\r\nOriginal instructions.\r\n\r\n```\r\nPlain code instructions\r\n```\r\n");
    await writeFile(join(bohemia, "agents", "reviewer.md"), "# Reviewer\n\nReview carefully.\n");
    await writeFile(join(bookCook, "agents", "cook.md"), "# Cook\n\nRecipe instructions.\n");
    for (const [project, id, status] of [
      ["bohemia", "A-1", "completed"], ["bohemia", "A-2", "failed"],
      ["book-cook", "B-1", "incoming"], ["book-cook", "B-2", "completed"], ["book-cook", "B-3", "completed"],
    ]) await writeFile(join(root, project, "queues", status, `${id}.json`),
      JSON.stringify({ id, title: `${project} task ${id}`, status, updated_at: new Date().toISOString(), prompt: "PRIVATE TASK PROMPT" }));
    await writeFile(registry, JSON.stringify({ version: 1, projects: [{ id: "bohemia", name: "Bohemia", root: bohemia }] }));
    let server: ChildProcess | undefined;
    const stop = async () => {
      if (server?.pid && server.exitCode === null) { const exited = once(server, "exit"); server.kill(); await exited; }
    };
    const start = async () => {
      const child = spawn(process.execPath, [resolve("node_modules", "next", "dist", "bin", "next"), "start", "--hostname", "127.0.0.1", "--port", String(address.port)], {
        env: { ...process.env, SPOOL_PROJECTS_FILE: registry, SPOOL_COPILOT_SESSION_ROOT: join(root, "sessions"),
          SPOOL_RUNNERS_HOME: join(root, "runner-service"), SPOOL_RUNNERS_CONFIG: join(root, "runner-service", "spool-runners.json") },
        stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
      });
      server = child;
      let output = "", bootError = "";
      child.stdout.on("data", (chunk) => { output = (output + chunk).slice(-8192); });
      child.stderr.on("data", (chunk) => { output = (output + chunk).slice(-8192); });
      child.once("error", (error) => { bootError = error.message; });
      await expect.poll(async () => {
        if (bootError || child.exitCode !== null) throw new Error(`Project fixture server failed: ${bootError}\n${output}`);
        try { return (await fetch(url)).status; } catch (error) { return String(error); }
      }, { timeout: 30_000 }).toBe(200);
    };
    try {
      await start();
      await use({ url, root, registry, bohemia, bookCook, empty, restart: async () => { await stop(); await start(); } });
    } finally { await stop(); await rm(root, { recursive: true, force: true }); }
  },
});
