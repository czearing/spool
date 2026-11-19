import { setTimeout } from "node:timers/promises";
import { watchFiles } from "./file-watch.mjs";

export async function waitForMessageReceipt(file, confirm) {
  let changed = () => {};
  const watcher = watchFiles(() => [{ path: file }], () => changed(), () => watcher.close());
  try {
    try { watcher.sync(); } catch { watcher.close(); }
    const deadline = performance.now() + 6000;
    do {
      const notification = new Promise(resolve => { changed = resolve; });
      const accepted = await confirm();
      if (accepted) return accepted;
      const controller = new AbortController();
      try { await Promise.race([notification, setTimeout(100, undefined, { signal: controller.signal })]); }
      finally { controller.abort(); }
    } while (performance.now() < deadline);
    return await confirm();
  } finally {
    watcher.close();
  }
}
