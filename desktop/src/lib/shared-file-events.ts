type Listener = { send: (value: Uint8Array) => void; end: () => void };
type Source = { abort: AbortController; listeners: Set<Listener>; latest?: Uint8Array };
const sources = new Map<string, Source>();
const encoder = new TextEncoder();
const dataPrefix = encoder.encode("data: ");

export function sharedFileEvents(key: string, signal: AbortSignal, create: (signal: AbortSignal) => Response) {
  let cancel = () => {}, pull = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (signal.aborted) { controller.close(); return; }
      let source = sources.get(key);
      if (!source) {
        source = { abort: new AbortController(), listeners: new Set() };
        sources.set(key, source);
        const owned = source;
        void Promise.resolve().then(async () => {
          try {
            const reader = create(owned.abort.signal).body!.getReader();
            try {
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                if (dataPrefix.every((byte, index) => value[index] === byte)) owned.latest = value;
                for (const listener of owned.listeners) listener.send(value);
              }
            } finally { reader.releaseLock(); }
          } catch {
            for (const listener of owned.listeners) listener.send(encoder.encode("event: unavailable\ndata: {}\n\n"));
          } finally {
            if (sources.get(key) === owned) sources.delete(key);
            for (const listener of [...owned.listeners]) listener.end();
            owned.abort.abort();
          }
        });
      }
      const owned = source;
      let pending: Uint8Array | undefined, ending = false, closed = false;
      const remove = () => {
        signal.removeEventListener("abort", abort);
        owned.listeners.delete(listener);
        if (!owned.listeners.size) {
          if (sources.get(key) === owned) sources.delete(key);
          owned.abort.abort();
        }
      };
      const flush = () => {
        if (closed) return;
        if (pending && controller.desiredSize! > 0) {
          const value = pending;
          pending = undefined;
          controller.enqueue(value);
        }
        if (!closed && ending && !pending) { closed = true; controller.close(); remove(); }
      };
      const listener: Listener = {
        send(value) {
          if (!pending || value[0] !== ":".charCodeAt(0)) pending = value;
          flush();
        },
        end() { ending = true; flush(); },
      };
      const abort = () => { if (!closed) { closed = true; controller.close(); remove(); } };
      cancel = () => { if (!closed) { closed = true; remove(); } };
      owned.listeners.add(listener);
      signal.addEventListener("abort", abort, { once: true });
      listener.send(encoder.encode("retry: 1000\n\n"));
      if (owned.latest) listener.send(owned.latest);
      pull = flush;
    },
    pull() { pull(); },
    cancel() { cancel(); },
  });
  return new Response(body, { headers: {
    "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no",
  } });
}
