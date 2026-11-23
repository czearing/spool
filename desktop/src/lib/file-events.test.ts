import { expect, it } from "vitest";
import { fileEvents } from "./file-events";

it("reconciles events received during a read before publishing a stale snapshot", async () => {
  const abort = new AbortController();
  let changed = () => {}, release = () => {}, value = 0, first = true;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const response = fileEvents(AbortSignal.any([abort.signal, AbortSignal.timeout(2000)]), async () => {
    const snapshot = value;
    if (first) { first = false; await gate; }
    return snapshot;
  }, notify => {
    changed = notify;
    return { sync: () => {}, close: () => {} };
  }, "test snapshots");
  const reader = response.body!.getReader();
  try {
    await reader.read();
    value = 1; changed(); release();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: 1\n\n");
  } finally { abort.abort(); }
});
it("does not starve subscribers while backfill events keep arriving during reads", async () => {
  const abort = new AbortController();
  let changed = () => {}, revision = 0;
  const response = fileEvents(AbortSignal.any([abort.signal, AbortSignal.timeout(2000)]), async () => {
    await new Promise(resolve => setTimeout(resolve, 10));
    changed();
    return ++revision;
  }, notify => {
    changed = notify;
    return { sync: () => {}, close: () => {} };
  }, "busy snapshots");
  const reader = response.body!.getReader();
  try {
    await reader.read();
    expect(new TextDecoder().decode((await reader.read()).value)).toMatch(/^data: \d+\n\n$/);
  } finally { abort.abort(); }
});
