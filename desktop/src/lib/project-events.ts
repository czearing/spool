import { join } from "node:path";
import { fileEvents } from "./file-events";
import { watchFiles } from "../../../packages/runners/bridge/file-watch.mjs";
import { readProjectLive } from "./project-live";
import { sharedFileEvents } from "./shared-file-events";

export function projectEvents(root: string, signal: AbortSignal, agent?: string) {
  const json = (file: string) => file.endsWith(".json");
  return sharedFileEvents(JSON.stringify([root, agent]), signal, shared =>
    fileEvents(shared, () => readProjectLive(root, agent), (changed, failed) => watchFiles(() => [
    { path: join(root, "agents"), directory: true, accepts: file => file.endsWith(".md") },
    ...["incoming", "in_progress", "completed", "failed", ".runner-archive"].map(queue =>
      ({ path: join(root, "queues", queue), directory: true, accepts: json })),
    ...["manual", "manual-history", "results", "ui-archive"].map(directory =>
      ({ path: join(root, "controls", directory), directory: true, accepts: json })),
    { path: join(root, "controls", "ui-archive.json") },
    { path: join(root, "usage", "accounting.json") },
  ], changed, failed), "project activity"));
}
