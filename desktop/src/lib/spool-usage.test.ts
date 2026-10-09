import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { readUsage } from "./spool-usage";
import { emptyUsage, summarizeUsage, type UsageRecord } from "./usage-summary";
import { formatUsd } from "./currency";
import { summarizeTasks } from "./dashboard";

let root: string;
const now = new Date("2026-10-01T12:00:00Z");
const row = (id: string, date: string, costUsd: number, agent: string | null = "engineer") => ({
  id, startedAt: `${date}T10:00:00Z`, endedAt: `${date}T11:00:00Z`, model: "gpt-6-astra", costUsd, agent,
  tokens: { uncachedInputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
});
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "spool-usage-")); await mkdir(join(root, "usage")); });
afterEach(() => rm(root, { recursive: true, force: true }));
async function put(records: object[], fields: object = {}) {
  await writeFile(join(root, "usage", "accounting.json"), JSON.stringify({
    version: 2, unit: "model_tokens", currency: "USD", unavailableTasks: [], sessions: { original: { records, error: null } }, ...fields,
  }));
}
it("uses provider usage intervals rather than the task's cumulative cost or latest update", async () => {
  await put([row("old", "2026-09-01", 100), row("middle", "2026-09-20", 2), row("new", "2026-10-01", 1)]);
  const history = await readUsage(root);
  const task = { id: "job", title: "Private", status: "completed" as const, updatedAt: now.toISOString(), agent: "engineer" };
  expect(summarizeTasks([task], now, "7d", [], history).totalCostUsd).toBe(1);
  expect(summarizeTasks([task], now, "14d", [], history).totalCostUsd).toBe(3);
  expect(summarizeTasks([task], now, "all", [], history).totalCostUsd).toBe(103);
  expect(summarizeTasks([{ ...task, updatedAt: "2026-09-01" }], now, "7d", [], history).totalCostUsd).toBe(1);
  expect(JSON.stringify(history)).not.toMatch(/original|Private|total_cost_usd/);
});
it("does not pretend to know where within a boundary-spanning interval usage occurred", async () => {
  await put([{ ...row("cross", "2026-09-25", 5), startedAt: "2026-09-24T23:59:59Z" },
    { ...row("future", "2026-10-01", 10), endedAt: "2026-10-02T01:00:00Z" }, row("inside", "2026-10-01", 2)]);
  const result = summarizeTasks([], now, "7d", [], await readUsage(root));
  expect(result.totalCostUsd).toBe(2);
  expect(result.excludedUsageIntervals).toBe(2);
});
it("distinguishes unavailable usage from genuine zero cost and retains recorded agent attribution", async () => {
  expect(await readUsage(root)).toEqual(emptyUsage);
  expect(summarizeTasks([], now).usageAvailable).toBe(false);
  await put([row("free", "2026-10-01", 0)]);
  expect(summarizeTasks([], now, "7d", [], await readUsage(root))).toMatchObject({ usageAvailable: true, totalCostUsd: 0, usage: [] });
  await put([row("known", "2026-10-01", 1.5, "former-agent"), row("unknown", "2026-10-01", 0.5, null)],
    { unavailableTasks: ["missing-generation"] });
  const result = summarizeTasks([], now, "7d", [], await readUsage(root));
  expect(result).toMatchObject({ totalCostUsd: 2, unavailableUsage: 1 });
  expect(result.usage).toEqual([{ label: "former-agent", value: 1.5 }, { label: "Unattributed", value: 0.5 }]);
});
it("refreshes native ledger updates and rejects invalid amounts, timestamps, units and duplicate identities", async () => {
  await put([row("one", "2026-10-01", 1)]);
  expect((await readUsage(root)).records[0].costUsd).toBe(1);
  await put([row("one", "2026-10-01", 2)]);
  expect((await readUsage(root)).records[0].costUsd).toBe(2);
  for (const patch of [{ costUsd: -1 }, { costUsd: undefined }, { costUsd: "invalid" },
    { tokens: {} }, { model: "" }, { startedAt: "invalid" }, { agent: "../bad" }]) {
    await put([{ ...row("bad", "2026-10-01", 1), ...patch }]);
    await expect(readUsage(root)).rejects.toThrow("Invalid Spool dollar interval");
  }
  await put([row("one", "2026-10-01", 1), row("one", "2026-10-01", 1)]);
  await expect(readUsage(root)).rejects.toThrow("Duplicate");
  await put([], { unit: "USD" });
  await expect(readUsage(root)).rejects.toThrow("Invalid");
  await put([], { currency: "EUR" });
  await expect(readUsage(root)).rejects.toThrow("currency");
});
it("reports missing provider histories instead of silently presenting zero", async () => {
  await put([], { sessions: { lost: { records: [], error: "History unavailable" } } });
  expect(summarizeTasks([], now, "7d", [], await readUsage(root))).toMatchObject({ usageAvailable: false, unavailableUsage: 1 });
});
it("formats USD while retaining sub-cent precision during aggregation", () => {
  expect(formatUsd(0)).toBe("$0.00"); expect(formatUsd(0.00001)).toBe("<$0.01");
  expect(formatUsd(1234.56789)).toBe("$1,234.57");
  const cents = summarizeUsage({ records: [row("a", "2026-10-01", 0.006), row("b", "2026-10-01", 0.006)],
    unavailableSources: 0, available: true }, 0, now.getTime(), true);
  expect(cents.totalCostUsd).toBe(0.012);
  const record: UsageRecord = { ...row("one", "2026-10-01", 1), costUsd: Number.MAX_SAFE_INTEGER };
  expect(() => summarizeUsage({ records: [record, record], unavailableSources: 0, available: true }, 0, now.getTime(), true)).toThrow("supported range");
});
it("consumes native dollar amounts without recreating Spool's pricing in the UI", async () => {
  await put([{ ...row("native", "2026-10-01", 1), costUsd: 7.5 }]);
  expect(summarizeTasks([], now, "7d", [], await readUsage(root)).totalCostUsd).toBe(7.5);
  await put([row("legacy", "2026-10-01", 1)], { currency: undefined });
  expect(await readUsage(root)).toEqual(emptyUsage);
  await put([row("legacy", "2026-10-01", 1)], { version: 1, unit: "nano_aiu" });
  expect(await readUsage(root)).toEqual(emptyUsage);
});
it("excludes unpriced model usage without pretending it was free", async () => {
  await put([{ ...row("unknown", "2026-10-01", 1), costUsd: null }]);
  expect(summarizeTasks([], now, "7d", [], await readUsage(root))).toMatchObject({ usageAvailable: false, unavailableUsage: 1 });
  await put([row("known", "2026-10-01", 2), { ...row("unknown", "2026-10-01", 1), costUsd: null }]);
  expect(summarizeTasks([], now, "7d", [], await readUsage(root))).toMatchObject({ totalCostUsd: 2, unavailableUsage: 1 });
});
