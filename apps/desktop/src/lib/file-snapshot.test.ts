import { beforeEach, expect, it, vi } from "vitest";
import { cachedFileReader, readFileSnapshot } from "./file-snapshot";
import { setImmediate } from "node:timers/promises";

const mocks = vi.hoisted(() => ({ stat: vi.fn() }));
vi.mock("node:fs/promises", () => ({ stat: mocks.stat }));
const file = "C:\\fixture\\task.json";
const version = (value: bigint) => ({ ino: 1n, mtimeNs: value, ctimeNs: value, size: 32n });
beforeEach(() => { mocks.stat.mockReset().mockResolvedValue(version(1n)); });

it("coalesces concurrent metadata probes across independent readers without hiding later edits", async () => {
  const left = cachedFileReader(async () => "Left"), right = cachedFileReader(async () => "Right");
  await Promise.all(Array.from({ length: 16 }, (_, index) => (index % 2 ? left : right)({ file })));
  expect(mocks.stat).toHaveBeenCalledTimes(1);
  mocks.stat.mockResolvedValue(version(2n));
  expect(await left({ file })).toBe("Left");
  expect(mocks.stat).toHaveBeenCalledTimes(2);
});

it("shares one payload read and parse across concurrent requests for the same file version", async () => {
  const pending = Promise.withResolvers<{ title: string }>(), value = { title: "Example" };
  const read = vi.fn(() => pending.promise), reader = cachedFileReader(read);
  const requests = Array.from({ length: 8 }, () => reader({ file }));
  await Promise.resolve();
  pending.resolve(value);
  const results = await Promise.all(requests);
  expect(read).toHaveBeenCalledOnce();
  expect(results.every(result => result === value)).toBe(true);
  expect(await reader({ file })).toBe(value);
  expect(read).toHaveBeenCalledOnce();
});
it("reports a shared read failure to every caller and retries instead of caching the error", async () => {
  const pending = Promise.withResolvers<string>(), error = new Error("Unreadable task");
  const read = vi.fn(() => pending.promise), reader = cachedFileReader(read);
  const requests = Promise.allSettled([reader({ file }), reader({ file })]);
  await Promise.resolve();
  pending.reject(error);
  expect(await requests).toEqual([{ status: "rejected", reason: error }, { status: "rejected", reason: error }]);
  expect(read).toHaveBeenCalledOnce();
  read.mockResolvedValue("Recovered");
  expect(await reader({ file })).toBe("Recovered");
  expect(read).toHaveBeenCalledTimes(2);
});
it("does not let a slow older read overwrite the cache for a newer file version", async () => {
  const pending = Promise.withResolvers<string>();
  const read = vi.fn().mockImplementationOnce(() => pending.promise).mockResolvedValue("New");
  const reader = cachedFileReader(read), older = reader({ file });
  await Promise.resolve();
  mocks.stat.mockResolvedValue(version(2n));
  expect(await reader({ file })).toBe("New");
  pending.resolve("Old");
  expect(await older).toBe("Old");
  expect(await reader({ file })).toBe("New");
  expect(read).toHaveBeenCalledTimes(2);
});
it("does not remove a newer cached result when an older read fails", async () => {
  const pending = Promise.withResolvers<string>();
  const read = vi.fn().mockImplementationOnce(() => pending.promise).mockResolvedValue("New");
  const reader = cachedFileReader(read), older = reader({ file });
  const rejected = expect(older).rejects.toThrow("Old read failed");
  await Promise.resolve();
  mocks.stat.mockResolvedValue(version(2n));
  expect(await reader({ file })).toBe("New");
  pending.reject(new Error("Old read failed"));
  await rejected;
  expect(await reader({ file })).toBe("New");
  expect(read).toHaveBeenCalledTimes(2);
});
it("checks file metadata on every request and surfaces deletion instead of returning stale data", async () => {
  const read = vi.fn().mockResolvedValue("Value"), reader = cachedFileReader(read);
  expect(await reader({ file })).toBe("Value");
  mocks.stat.mockRejectedValueOnce(Object.assign(new Error("Missing"), { code: "ENOENT" }));
  await expect(reader({ file })).rejects.toMatchObject({ code: "ENOENT" });
  mocks.stat.mockResolvedValue(version(2n));
  expect(await reader({ file })).toBe("Value");
  expect(read).toHaveBeenCalledTimes(2);
  expect(mocks.stat).toHaveBeenCalledTimes(3);
});
it("keeps the existing 2,000-file bound instead of retaining every task ever read", async () => {
  const read = vi.fn(async ({ file }: { file: string }) => file), reader = cachedFileReader(read);
  for (let index = 0; index <= 2000; index++) await reader({ file: `${file}-${index}` });
  await reader({ file: `${file}-2000` });
  expect(read).toHaveBeenCalledTimes(2001);
  await reader({ file: `${file}-0` });
  expect(read).toHaveBeenCalledTimes(2002);
});
it("bounds concurrent disk reads and preserves listing order despite out-of-order completion", async () => {
  const entries = Array.from({ length: 128 }, (_, index) => ({ file: String(index) }));
  let active = 0, peak = 0;
  const items = await readFileSnapshot(async () => entries, async ({ file }) => {
    active++; peak = Math.max(peak, active);
    for (let count = 0; count <= Number(file) % 3; count++) await setImmediate();
    active--;
    return file;
  }, "Test files");
  expect(peak).toBeGreaterThan(1);
  expect(peak).toBeLessThanOrEqual(32);
  expect(items).toEqual(entries.map(({ file }) => file));
});
it("settles in-flight reads before retrying an atomic queue transition", async () => {
  const entries = Array.from({ length: 64 }, (_, index) => ({ file: String(index) }));
  let active = 0, moved = false;
  const list = vi.fn(async () => { expect(active).toBe(0); return entries; });
  const items = await readFileSnapshot(list, async ({ file }) => {
    active++;
    try {
      if (!moved && file === "0") {
        moved = true;
        throw Object.assign(new Error("Moved"), { code: "ENOENT" });
      }
      await setImmediate();
      return file;
    } finally { active--; }
  }, "Moving files");
  expect(items).toEqual(entries.map(({ file }) => file));
  expect(list).toHaveBeenCalledTimes(3);
  expect(active).toBe(0);
});
