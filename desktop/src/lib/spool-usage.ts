import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { cachedFileReader, hasCode } from "./file-snapshot";
import { emptyUsage, type UsageHistory, type UsageRecord } from "./usage-summary";

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const readLedger = cachedFileReader(async ({ file }: { file: string }): Promise<UsageHistory> => {
  const ledger: unknown = JSON.parse(await readFile(file, "utf8"));
  if (record(ledger) && ledger.version === 1 && ledger.unit === "nano_aiu") return emptyUsage;
  if (!record(ledger) || ledger.version !== 2 || ledger.unit !== "model_tokens" || !record(ledger.sessions)
    || !Array.isArray(ledger.unavailableTasks) || !ledger.unavailableTasks.every((id) => typeof id === "string")) {
    throw new Error("Invalid Spool provider usage ledger.");
  }
  if (ledger.currency === undefined) return emptyUsage;
  if (ledger.currency !== "USD") throw new Error("Unsupported Spool usage currency.");
  const records: UsageRecord[] = [], identities = new Set<string>();
  let unavailableSources = ledger.unavailableTasks.length;
  for (const [session, snapshot] of Object.entries(ledger.sessions)) {
    if (!record(snapshot) || !Array.isArray(snapshot.records) || snapshot.error !== null && typeof snapshot.error !== "string") {
      throw new Error("Invalid Spool session usage.");
    }
    let incomplete = !!snapshot.error;
    for (const row of snapshot.records) {
      if (!record(row) || typeof row.id !== "string" || !row.id || typeof row.startedAt !== "string" ||
        typeof row.endedAt !== "string" || !Number.isFinite(Date.parse(row.startedAt)) ||
        !Number.isFinite(Date.parse(row.endedAt)) || Date.parse(row.startedAt) > Date.parse(row.endedAt) ||
        typeof row.model !== "string" || !row.model || !record(row.tokens) ||
        !["uncachedInputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"].every((key) =>
          record(row.tokens) && typeof row.tokens[key] === "number" && Number.isSafeInteger(row.tokens[key]) && row.tokens[key] >= 0) ||
        row.costUsd !== null && (typeof row.costUsd !== "number" || !Number.isFinite(row.costUsd) || row.costUsd < 0 || row.costUsd > Number.MAX_SAFE_INTEGER) ||
        row.agent !== null && (typeof row.agent !== "string" || !/^[a-zA-Z0-9_.-]+$/.test(row.agent))) {
        throw new Error("Invalid Spool dollar interval.");
      }
      const identity = JSON.stringify([session, row.id]);
      if (identities.has(identity)) throw new Error("Duplicate Spool dollar interval.");
      identities.add(identity);
      if (row.costUsd === null) { incomplete = true; continue; }
      records.push({ startedAt: row.startedAt, endedAt: row.endedAt, costUsd: row.costUsd, agent: row.agent });
    }
    if (incomplete) unavailableSources++;
  }
  return { records, unavailableSources, available: true };
});
export async function readUsage(root: string): Promise<UsageHistory> {
  try { return await readLedger({ file: join(root, "usage", "accounting.json") }); }
  catch (error) { if (hasCode(error, "ENOENT")) return emptyUsage; throw error; }
}
