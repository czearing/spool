import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { hasCode } from "./file-snapshot";
import { isRunnerSnapshot, type RunnerSnapshot } from "./runners";

const cache = new Map<string, { until: number; result: Promise<RunnerSnapshot> }>();
export function runnerLocations() {
  const home = process.env.SPOOL_RUNNERS_HOME ?? resolve(process.cwd(), "..", "spool-runners");
  const config = process.env.SPOOL_RUNNERS_CONFIG ?? join(home, "spool-runners.json");
  return { home: resolve(/* turbopackIgnore: true */ home), config: resolve(/* turbopackIgnore: true */ config) };
}
export function readRunners(root: string, fresh = false): Promise<RunnerSnapshot> {
  const { home, config } = runnerLocations();
  const key = JSON.stringify([home, config, root]), saved = cache.get(key);
  if (!fresh && saved && saved.until > Date.now()) return saved.result;
  const result = inspect(root, home, config);
  cache.set(key, { until: Infinity, result });
  const oldest = cache.keys().next().value;
  if (cache.size > 100 && oldest !== undefined) cache.delete(oldest);
  result.then(() => { if (cache.get(key)?.result === result) cache.set(key, { until: Date.now() + 5000, result }); },
    () => { if (cache.get(key)?.result === result) cache.delete(key); });
  return result;
}
async function inspect(root: string, home: string, config: string): Promise<RunnerSnapshot> {
  try { await access(config); }
  catch (error) {
    if (hasCode(error, "ENOENT")) return { checkedAt: new Date().toISOString(), configured: false, runners: [] };
    throw error;
  }
  const source: unknown = await import(pathToFileURL(join(home, "bridge", "runner-snapshot.mjs")).href);
  if (!source || typeof source !== "object" || !("runnerSnapshot" in source) || typeof source.runnerSnapshot !== "function") {
    throw new Error("Runner installation does not expose the supported status reader.");
  }
  const configuration: unknown = JSON.parse((await readFile(config, "utf8")).replace(/^\uFEFF/, ""));
  const value: unknown = await source.runnerSnapshot(configuration, root, join(home, "runners"));
  if (!isRunnerSnapshot(value)) throw new Error("Invalid runner status response.");
  return value;
}
