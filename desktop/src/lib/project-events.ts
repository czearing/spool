import { join } from "node:path";
import { fileEvents } from "./file-events";
import { watchFiles } from "../../../packages/runners/bridge/file-watch.mjs";
import { invalidateActivity, readProjectLive, watchActivity } from "./project-live";
import { sharedFileEvents } from "./shared-file-events";

export function projectEvents(root: string, signal: AbortSignal, agent?: string) {
  const json = (file: string) => file.endsWith(".json");
  return sharedFileEvents(JSON.stringify([root, agent]), signal, shared =>
    fileEvents(shared, () => readProjectLive(root, agent), (changed, failed) => {
      const unwatch = watchActivity(root, changed);
      let watcher: ReturnType<typeof watchFiles>;
      try { watcher = watchFiles(() => [
    { path: join(root, "agents"), directory: true, accepts: file => file.endsWith(".md") },
    ...["incoming", "in_progress", "completed", "failed", ".runner-archive"].map(queue =>
      ({ path: join(root, "queues", queue), directory: true, accepts: json })),
    ...["manual", "manual-history", "results", "ui-archive", "failure-origins"].map(directory =>
      ({ path: join(root, "controls", directory), directory: true, accepts: json })),
    { path: join(root, "controls", "ui-archive.json") },
    { path: join(root, "usage", "accounting.json") },
      ], () => { invalidateActivity(root); changed(); }, failed); }
      catch (error) { unwatch(); throw error; }
      return { sync: () => watcher.sync(), close: () => { unwatch(); watcher.close(); } };
    }, "project activity"));
}
