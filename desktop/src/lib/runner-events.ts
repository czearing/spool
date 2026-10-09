import { readRunners } from "./runner-client";
import { watchRunnerFiles } from "./runner-watch";

export function runnerEvents(root: string, signal: AbortSignal) {
  let stop = (_close: boolean) => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false, busy = false, dirty = false, previous = "";
      let debounce: ReturnType<typeof setTimeout> | undefined;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const cleanup = (close = true) => {
        if (closed) return;
        closed = true;
        clearTimeout(debounce); clearInterval(heartbeat);
        watcher.close();
        signal.removeEventListener("abort", abort);
        if (close) controller.close();
      };
      const abort = () => cleanup();
      const send = (text: string) => { if (!closed) controller.enqueue(encoder.encode(text)); };
      const fail = (error: unknown) => {
        if (closed) return;
        console.error("Cannot stream runner status.", error);
        send('event: unavailable\ndata: {}\n\n');
        cleanup();
      };
      const refresh = async () => {
        if (closed) return;
        if (busy) { dirty = true; return; }
        busy = true;
        try {
          do {
            dirty = false;
            watcher.sync();
            const snapshot = await readRunners(root, true);
            const signature = JSON.stringify([snapshot.configured, snapshot.runners]);
            if (signature !== previous) { send(`data: ${JSON.stringify(snapshot)}\n\n`); previous = signature; }
          } while (dirty && !closed);
        } catch (error) { fail(error); }
        finally { busy = false; }
      };
      const changed = () => {
        if (closed) return;
        if (busy) { dirty = true; return; }
        debounce ??= setTimeout(() => { debounce = undefined; void refresh(); }, 20);
      };
      const watcher = watchRunnerFiles(changed, fail);
      stop = cleanup;
      if (signal.aborted) { cleanup(); return; }
      signal.addEventListener("abort", abort, { once: true });
      send("retry: 1000\n\n");
      // Recheck silent process failures; scan and configuration updates arrive through the watcher.
      heartbeat = setInterval(() => { send(": keepalive\n\n"); void refresh(); }, 30000);
      void refresh();
    },
    cancel() { stop(false); },
  });
  return new Response(stream, { headers: {
    "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no",
  } });
}
