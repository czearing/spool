import { readFileSync, existsSync, renameSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { readConversationTask } from "./conversation-store";

vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, readFileSync: vi.fn(fs.readFileSync) };
});

let root: string;
const task = { id: "one", title: "Fixture", agent: "engineer", prompt: "Fixture; never executed." };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "spool-task-reader-"));
  await Promise.all(["incoming", "in_progress", "completed", "failed"]
    .map(state => mkdir(join(root, "queues", state), { recursive: true })));
});
afterEach(async () => {
  vi.mocked(readFileSync).mockReset();
  await rm(root, { recursive: true, force: true });
});

it("does not lose an incoming task when the daemon moves it to in_progress during lookup", async () => {
  const incoming = join(root, "queues", "incoming", "one.json");
  const running = join(root, "queues", "in_progress", "one.json");
  await writeFile(incoming, JSON.stringify(task));
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  vi.mocked(readFileSync).mockImplementation((...args) => {
    if (String(args[0]) === incoming && existsSync(incoming)) renameSync(incoming, running);
    return actual.readFileSync(...args);
  });
  expect(readConversationTask(root, "one")).toMatchObject({ id: "one", status: "in_progress" });
  expect(existsSync(running)).toBe(true);
});

it("uses queue precedence and queue location rather than stale embedded status", async () => {
  for (const state of ["incoming", "in_progress", "completed", "failed"])
    await writeFile(join(root, "queues", state, "one.json"), JSON.stringify({ ...task, status: "failed" }));
  expect(readConversationTask(root, "one")).toMatchObject({ id: "one", status: "in_progress" });
});

for (const invalid of [null, false, { ...task, id: "other" }, { ...task, agent: null }, { id: task.id, agent: task.agent }])
it(`rejects invalid target records rather than treating them as missing: ${JSON.stringify(invalid)}`, async () => {
  await writeFile(join(root, "queues", "incoming", "one.json"), JSON.stringify(invalid));
  expect(() => readConversationTask(root, "one")).toThrow(/Invalid .*task/);
});

it("returns null only for an absent task", () => {
  expect(readConversationTask(root, "one")).toBeNull();
});

it("retains desktop identity validation", () => {
  for (const id of ["../one", "a".repeat(181)])
    expect(() => readConversationTask(root, id)).toThrow("Invalid task identity.");
});

it("rejects persistently malformed task JSON", async () => {
  await writeFile(join(root, "queues", "incoming", "one.json"), "{");
  expect(() => readConversationTask(root, "one")).toThrow(/Cannot read/);
});

it("retries a transient partial daemon write", async () => {
  const file = join(root, "queues", "incoming", "one.json");
  await writeFile(file, JSON.stringify(task));
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  let partial = true;
  vi.mocked(readFileSync).mockImplementation((...args) => {
    if (String(args[0]) === file && partial) {
      partial = false;
      return "{";
    }
    return actual.readFileSync(...args);
  });
  expect(readConversationTask(root, "one")?.id).toBe("one");
  expect(partial).toBe(false);
});
