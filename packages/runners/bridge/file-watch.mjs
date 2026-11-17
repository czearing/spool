import { statSync, watch } from "node:fs";
import { dirname, resolve, sep } from "node:path";

export function watchFiles(targets, changed, failed, { persistent = false } = {}) {
  const watchers = new Map();
  const sync = () => {
    const wanted = new Set();
    for (const target of targets()) {
      const directory = target.directory ? target.path : dirname(target.path);
      let parent = directory, identity;
      for (;;) {
        try {
          const info = statSync(parent);
          if (!info.isDirectory()) throw new Error("Watch path is not a directory.");
          identity = `${info.dev}:${info.ino}`; break;
        }
        catch (error) {
          if (error?.code !== "ENOENT" || dirname(parent) === parent) throw error;
          parent = dirname(parent);
        }
      }
      const key = JSON.stringify([target.path, parent, identity]);
      wanted.add(key);
      if (watchers.has(key)) continue;
      const watcher = watch(parent, { persistent }, (event, filename) => {
        if (!filename) { changed(); return; }
        const file = resolve(parent, filename);
        if (parent !== directory) {
          if (file === target.path || target.path.startsWith(`${file}${sep}`)) changed();
        } else if (target.directory ? !target.accepts || target.accepts(file, event) : file === target.path) changed();
      });
      watcher.on("error", failed);
      watchers.set(key, watcher);
    }
    for (const [key, watcher] of watchers) if (!wanted.has(key)) { watcher.close(); watchers.delete(key); }
  };
  return { sync, close: () => { for (const watcher of watchers.values()) watcher.close(); watchers.clear(); } };
}
