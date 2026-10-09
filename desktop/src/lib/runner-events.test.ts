import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readRunners, runnerLocations } from "./runner-client";
import { runnerEvents } from "./runner-events";
import type { RunnerSnapshot } from "./runners";

vi.mock("./runner-client", () => ({ readRunners: vi.fn(), runnerLocations: vi.fn() }));
let home: string, config: string, abort: AbortController;
const initial: RunnerSnapshot = { checkedAt: "2026-10-05T17:00:00Z", configured: false, runners: [] };
const changed: RunnerSnapshot = { ...initial, configured: true };
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "runner-events-"));
  config = join(home, "config.json"); abort = new AbortController();
  vi.mocked(runnerLocations).mockReturnValue({ home, config });
  vi.mocked(readRunners).mockReset().mockResolvedValue(initial);
  await writeFile(config, "{}");
});
afterEach(async () => { abort.abort(); vi.restoreAllMocks(); await rm(home, { recursive: true, force: true }); });
async function nextData(reader: ReadableStreamDefaultReader<Uint8Array>) {
  for (;;) {
    const { done, value } = await reader.read();
    if (done) throw new Error("Stream closed without a snapshot.");
    const text = new TextDecoder().decode(value);
    if (text.startsWith("data: ")) return JSON.parse(text.slice(6));
  }
}
async function replace(file: string) {
  await writeFile(`${file}.tmp`, "{}"); await rename(`${file}.tmp`, file);
}

it("streams atomic config replacements immediately and releases watchers when cancelled", async () => {
  const response = runnerEvents(home, abort.signal), reader = response.body!.getReader();
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  expect(await nextData(reader)).toEqual(initial);
  vi.mocked(readRunners).mockResolvedValue(changed);
  await replace(config);
  expect(await nextData(reader)).toEqual(changed);
  expect(readRunners).toHaveBeenLastCalledWith(home, true);
  await reader.cancel();
  const calls = vi.mocked(readRunners).mock.calls.length;
  await replace(config); await delay(100);
  expect(readRunners).toHaveBeenCalledTimes(calls);
});

it("attaches to missing runner directories and ignores unrelated log writes", async () => {
  const reader = runnerEvents(home, abort.signal).body!.getReader();
  expect(await nextData(reader)).toEqual(initial);
  const runtime = join(home, "runners", "livesite", ".runner");
  vi.mocked(readRunners).mockResolvedValue(changed);
  await mkdir(runtime, { recursive: true });
  expect(await nextData(reader)).toEqual(changed);
  vi.mocked(readRunners).mockResolvedValue(initial);
  await replace(join(runtime, "status.json"));
  expect(await nextData(reader)).toEqual(initial);
  await delay(100);
  const calls = vi.mocked(readRunners).mock.calls.length;
  await writeFile(join(runtime, "scan.log"), "unrelated output"); await delay(100);
  expect(readRunners).toHaveBeenCalledTimes(calls);
});

it("rechecks changes arriving during an in-flight read rather than serving its cached result", async () => {
  let finish!: (snapshot: RunnerSnapshot) => void;
  vi.mocked(readRunners).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue(changed);
  const reader = runnerEvents(home, abort.signal).body!.getReader();
  await replace(config); await delay(100);
  finish(initial);
  expect(await nextData(reader)).toEqual(initial);
  expect(await nextData(reader)).toEqual(changed);
});

it("logs read failures, sends a safe unavailable event, and closes for automatic reconnect", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(readRunners).mockRejectedValue(new Error("PRIVATE failure details"));
  const reader = runnerEvents(home, abort.signal).body!.getReader();
  await reader.read();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("event: unavailable\ndata: {}\n\n");
  expect((await reader.read()).done).toBe(true);
  expect(log).toHaveBeenCalledOnce();
});
