import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, expect } from "./spool-task-fixture";

test.use({ interactive: true });
test("native Spool prices model token increments once across continuation, not credits", async ({ page, request, projectServer: server, scheduler }) => {
  void scheduler;
  const id = "usage-proof", now = new Date().toISOString();
  const completed = join(server.bohemia, "queues", "completed", `${id}.json`);
  await writeFile(join(server.bohemia, "queues", "incoming", `${id}.json`), JSON.stringify({
    id, agent: "engineer", model: "gpt-6-astra", title: "Usage proof", prompt: "A fixture-only request", status: "incoming", created_at: now, updated_at: now,
  }));
  await rm(join(server.bohemia, "controls", "paused", "engineer"));
  const saved = async () => {
    try { return JSON.parse(await readFile(completed, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  };
  await expect.poll(saved, { timeout: 15000 }).toMatchObject({ session_id: "isolated-acp-session", cost: { total_cost_usd: 0, input_tokens: 100 } });
  await page.goto(`${server.url}/bohemia`);
  const total = page.getByLabel("Total recorded cost", { exact: true });
  await expect(total).toHaveText("<$0.01");
  const message = { id: randomUUID(), message: "Continue the fixture session." };
  const url = `${server.url}/api/projects/bohemia/tasks/${id}/conversation`;
  expect((await request.post(url, { headers: { Origin: server.url }, data: message })).status()).toBe(200);
  await expect.poll(saved, { timeout: 15000 }).toMatchObject({ interaction: { messages: [{ status: "delivered" }] }, cost: { total_cost_usd: 0, input_tokens: 200 } });
  await expect.poll(async () => (await (await request.get(`${server.url}/api/projects/bohemia/dashboard`)).json()).totalCostUsd).toBeCloseTo(0.0009, 8);
  await expect(total).toHaveText("<$0.01", { timeout: 10000 });
  const ledger = JSON.parse(await readFile(join(server.bohemia, "usage", "accounting.json"), "utf8"));
  const records = ledger.sessions["isolated-acp-session"].records;
  expect(records).toHaveLength(2);
  expect(ledger.version).toBe(2);
  expect(records.map((row: { model: string }) => row.model)).toEqual(["gpt-6-astra", "gpt-6-astra"]);
  expect(records.map((row: { tokens: { uncachedInputTokens: number } }) => row.tokens.uncachedInputTokens)).toEqual([100, 100]);
  expect(ledger.currency).toBe("USD");
  expect(records.map((row: { costUsd: number }) => row.costUsd)).toEqual([0.00045, 0.00045]);
  expect(records.map((row: { agent: string }) => row.agent)).toEqual(["engineer", "engineer"]);
  expect((await request.post(url, { headers: { Origin: server.url }, data: message })).status()).toBe(200);
  await scheduler.restart();
  const data = await (await request.get(`${server.url}/api/projects/bohemia/dashboard`)).json();
  expect(data.totalCostUsd).toBe(0.0009);
  expect(data).not.toHaveProperty("totalCredits");
});
