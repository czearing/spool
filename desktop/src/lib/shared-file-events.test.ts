import { expect, it, vi } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import { fileEvents } from "./file-events";
import { sharedFileEvents } from "./shared-file-events";

async function snapshot(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<number> {
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error("Missing snapshot");
    const text = new TextDecoder().decode(value);
    if (text.startsWith("data: ")) return JSON.parse(text.slice(6));
  }
}
it("shares sixteen watched refreshes, replays late joins, and closes only after the last subscriber", async () => {
  const aborts = Array.from({ length: 17 }, () => new AbortController());
  const close = vi.fn(), read = vi.fn(async () => 1);
  const create = vi.fn((signal: AbortSignal) => fileEvents(signal, read,
    () => ({ sync() {}, close }), "shared fixture"));
  try {
    const readers = aborts.slice(0, 16).map(abort => sharedFileEvents("fanout", abort.signal, create).body!.getReader());
    expect(await Promise.all(readers.map(snapshot))).toEqual(Array(16).fill(1));
    expect(create).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledOnce();
    aborts[0].abort();
    expect(close).not.toHaveBeenCalled();
    expect(await snapshot(sharedFileEvents("fanout", aborts[16].signal, create).body!.getReader())).toBe(1);
    expect(read).toHaveBeenCalledOnce();
  } finally { aborts.forEach(abort => abort.abort()); }
  expect(close).toHaveBeenCalledOnce();
});
it("keeps a slow subscriber bounded without blocking a fast subscriber or losing the latest snapshot", async () => {
  const fast = new AbortController(), slow = new AbortController();
  let value = 0, changed = () => {};
  const create = (signal: AbortSignal) => fileEvents(signal, async () => value,
    notify => { changed = notify; return { sync() {}, close() {} }; }, "slow fixture");
  try {
    const fastReader = sharedFileEvents("backpressure", fast.signal, create).body!.getReader();
    const slowReader = sharedFileEvents("backpressure", slow.signal, create).body!.getReader();
    expect(await snapshot(fastReader)).toBe(0);
    for (value = 1; value <= 5; value++) {
      changed();
      expect(await snapshot(fastReader)).toBe(value);
    }
    expect(await snapshot(slowReader)).toBe(5);
  } finally { fast.abort(); slow.abort(); }
});
it("isolates keys and recreates a stopped source without retaining stale snapshots", async () => {
  const first = new AbortController(), second = new AbortController(), third = new AbortController();
  let value = 1;
  const create = vi.fn((signal: AbortSignal) => fileEvents(signal, async () => value,
    () => ({ sync() {}, close() {} }), "restart fixture"));
  try {
    expect(await snapshot(sharedFileEvents("restart", first.signal, create).body!.getReader())).toBe(1);
    first.abort(); value = 2;
    expect(await snapshot(sharedFileEvents("restart", second.signal, create).body!.getReader())).toBe(2);
    expect(await snapshot(sharedFileEvents("separate", third.signal, create).body!.getReader())).toBe(2);
    expect(create).toHaveBeenCalledTimes(3);
    await delay(0);
  } finally { first.abort(); second.abort(); third.abort(); }
});
it("closes failed sources for every subscriber and permits a fresh retry", async () => {
  const first = new AbortController(), second = new AbortController(), retry = new AbortController();
  const create = vi.fn((): Response => { throw new Error("Cannot watch fixture"); });
  try {
    const readers = [first, second].map(abort => sharedFileEvents("failure", abort.signal, create).body!.getReader());
    for (const reader of readers) {
      expect(new TextDecoder().decode((await reader.read()).value)).toContain("retry:");
      expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: unavailable");
      expect((await reader.read()).done).toBe(true);
    }
    expect(create).toHaveBeenCalledOnce();
    expect(await snapshot(sharedFileEvents("failure", retry.signal, signal => fileEvents(signal, async () => 2,
      () => ({ sync() {}, close() {} }), "recovered fixture")).body!.getReader())).toBe(2);
  } finally { first.abort(); second.abort(); retry.abort(); }
});
