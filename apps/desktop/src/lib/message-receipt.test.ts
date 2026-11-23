import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { waitForMessageReceipt } from "../../../../packages/runners/bridge/message-receipt.mjs";
import * as fileWatch from "../../../../packages/runners/bridge/file-watch.mjs";
import { publishJson, readOptionalJson } from "./spool-publish";

vi.mock("node:timers/promises", async importOriginal => {
  const timers = await importOriginal<typeof import("node:timers/promises")>();
  return { ...timers, setTimeout: vi.fn(timers.setTimeout) };
});

let root: string, file: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "spool-receipt-"));
  file = join(root, "receipt.json");
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(delay).mockReset();
  await rm(root, { force: true, recursive: true });
});
const accepted = async () => {
  const receipt = await readOptionalJson(file) as { result?: { status?: string } } | undefined;
  return receipt?.result?.status === "accepted" ? receipt : undefined;
};
const receipt = { result: { status: "accepted" } };

it("reads receipts already published before watching without waiting for a poll", async () => {
  await publishJson(file, receipt);
  expect(await waitForMessageReceipt(file, accepted)).toEqual(receipt);
  expect(delay).not.toHaveBeenCalled();
});

it("uses atomic receipt notifications and aborts the losing polling timer", async () => {
  vi.mocked(delay).mockImplementation(<T = void>() => new Promise<T>(() => {}));
  const pending = waitForMessageReceipt(file, accepted);
  await expect.poll(() => vi.mocked(delay).mock.calls.length).toBeGreaterThan(0);
  await publishJson(file, receipt);
  expect(await pending).toEqual(receipt);
  expect(vi.mocked(delay).mock.calls[0][2]?.signal?.aborted).toBe(true);
});

for (const failure of ["setup", "runtime"])
it(`retains polling when receipt watching fails during ${failure}`, async () => {
  const close = vi.fn();
  vi.spyOn(fileWatch, "watchFiles").mockImplementation((_targets, _changed, failed) => ({
    sync: () => {
      if (failure === "setup") throw new Error("Cannot watch receipts");
      failed(new Error("Receipt watcher stopped"));
    }, close,
  }));
  const pending = waitForMessageReceipt(file, accepted);
  await expect.poll(() => vi.mocked(delay).mock.calls.length).toBeGreaterThan(0);
  await publishJson(file, receipt);
  expect(await pending).toEqual(receipt);
  expect(close).toHaveBeenCalled();
});

it("closes receipt watching and preserves confirmation errors", async () => {
  const close = vi.fn(), error = new Error("Spool rejected this message");
  vi.spyOn(fileWatch, "watchFiles").mockReturnValue({ sync: () => {}, close });
  await expect(waitForMessageReceipt(file, () => { throw error; })).rejects.toBe(error);
  expect(close).toHaveBeenCalledOnce();
  expect(delay).not.toHaveBeenCalled();
});

it("does not mistake event storms for acceptance or exhaust a fixed attempt count", async () => {
  let changed = () => {}, time = 0;
  const close = vi.fn();
  vi.spyOn(fileWatch, "watchFiles").mockImplementation((_targets, notify) => {
    changed = notify;
    return { sync: () => {}, close };
  });
  vi.spyOn(performance, "now").mockImplementation(() => time);
  vi.mocked(delay).mockImplementation(<T = void>() => new Promise<T>(() => {}));
  const confirm = vi.fn(() => {
    time += 10;
    queueMicrotask(() => changed());
    return false;
  });
  expect(await waitForMessageReceipt(file, confirm)).toBe(false);
  expect(confirm).toHaveBeenCalledTimes(601);
  expect(time).toBeGreaterThanOrEqual(6000);
  expect(close).toHaveBeenCalledOnce();
});

it("checks again for a missed receipt when the final fallback poll reaches the deadline", async () => {
  let time = 0;
  const close = vi.fn();
  vi.spyOn(fileWatch, "watchFiles").mockReturnValue({ sync: () => {}, close });
  vi.spyOn(performance, "now").mockImplementation(() => time);
  vi.mocked(delay).mockImplementation(async () => {
    await publishJson(file, receipt);
    time = 6000;
  });
  expect(await waitForMessageReceipt(file, accepted)).toEqual(receipt);
  expect(close).toHaveBeenCalledOnce();
});
