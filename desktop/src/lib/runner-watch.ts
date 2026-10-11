import { statSync, watch, type FSWatcher } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { hasCode } from "./file-snapshot";
import { runnerLocations } from "./runner-client";

export function watchRunnerFiles(changed: () => void, failed: (error: Error) => void, root: string, catalog = false) {
  const watchers = new Map<string, FSWatcher>();
  const sync = () => {
    const { config, runtime } = runnerLocations(root), runners = join(runtime, "runners");
    const wanted = new Set<string>();
    for (const target of new Set([config, ...(catalog ? [join(runtime, "service.json")] : [runners]),
      join(root, ".runner", "automation", "spool-runners.json")])) {
      const directory = target === runners ? target : dirname(target);
      let parent = directory;
      for (;;) {
        try { if (!statSync(parent).isDirectory()) throw new Error("Runner watch path is not a directory."); break; }
        catch (error) {
          if (!hasCode(error, "ENOENT") || dirname(parent) === parent) throw error;
          parent = dirname(parent);
        }
      }
      const recursive = target === runners && parent === runners;
      const key = JSON.stringify([target, parent]);
      wanted.add(key);
      if (watchers.has(key)) continue;
      const watcher = watch(parent, { recursive, persistent: false }, (event, filename) => {
        if (!filename) { changed(); return; }
        const file = resolve(parent, filename);
        if (parent !== directory) {
          if (target === file || target.startsWith(`${file}${sep}`)) changed();
        } else if (target !== runners ? file === target :
          /^[^\\/]+[\\/]\.runner[\\/](?:status|pid|repository-refresh)\.json$/.test(relative(runners, file)) ||
          event === "rename" && /^[^\\/]+(?:[\\/]\.runner)?$/.test(relative(runners, file))) changed();
      });
      watcher.on("error", failed);
      watchers.set(key, watcher);
    }
    for (const [key, watcher] of watchers) if (!wanted.has(key)) { watcher.close(); watchers.delete(key); }
  };
  return { sync, close: () => { for (const watcher of watchers.values()) watcher.close(); watchers.clear(); } };
}
