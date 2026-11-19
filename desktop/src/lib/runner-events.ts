import { join } from "node:path";
import { readRunnerCatalog } from "./runner-catalog";
import { runnerLocations } from "./runner-client";
import { fileEvents } from "./file-events";
import { watchFiles } from "../../../packages/runners/bridge/file-watch.mjs";

export function runnerEvents(root: string, signal: AbortSignal) {
  return fileEvents(signal, () => readRunnerCatalog(root),
    (changed, failed) => watchFiles(() => {
      const { config, runtime } = runnerLocations(root);
      return [...new Set([config, join(runtime, "service.json"),
        join(root, ".runner", "automation", "spool-runners.json")])].map(path => ({ path }));
    }, changed, failed), "runner navigation");
}
