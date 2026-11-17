import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { readTaskPreparations } from "./task-preparations";

const reads = vi.hoisted(() => ({ readFile: vi.fn() }));
vi.mock("node:fs/promises", async original => ({ ...await original<typeof import("node:fs/promises")>(), ...reads }));
const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
let root: string;
const job = (status: string) => ({ status, request: { kind: "create", taskId: "manual-one", title: "Requested task", agent: "engineer", prompt: "PRIVATE" } });
const file = (folder: string, name = "one") => join(root, "controls", folder, `${name}.json`);
beforeEach(async () => {
  reads.readFile.mockReset().mockImplementation(original.readFile);
  root = await mkdtemp(join(tmpdir(), "spool-preparation-"));
  for (const folder of ["manual", "manual-history", "results"]) await mkdir(join(root, "controls", folder), { recursive: true });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
it("handles projects with no runner control folders", async () => {
  await expect(readTaskPreparations(join(root, "unconfigured"))).resolves.toEqual([]);
});
it.each(["waiting", "preparing", "submitted", "prepared"])("exposes %s progress without prompts or workspace details", async (status) => {
  await writeFile(file("manual"), JSON.stringify(job(status)));
  expect(await readTaskPreparations(root)).toEqual([{
    id: "manual-one", title: "Requested task", agent: "engineer", stage: status === "prepared" ? "submitted" : status,
  }]);
});
it("rereads status changes rather than caching active preparation", async () => {
  await writeFile(file("manual"), JSON.stringify(job("waiting"))); await readTaskPreparations(root);
  await writeFile(file("manual"), JSON.stringify(job("preparing")));
  expect((await readTaskPreparations(root))[0].stage).toBe("preparing");
});
it("reuses unchanged request payloads but checks new failure and acceptance receipts on every poll", async () => {
  await writeFile(file("manual"), JSON.stringify(job("submitted")));
  await readTaskPreparations(root); await readTaskPreparations(root);
  reads.readFile.mockClear();
  expect((await readTaskPreparations(root))[0].stage).toBe("submitted");
  expect(reads.readFile.mock.calls.map(([name]) => name)).toEqual([file("results")]);
  await writeFile(file("results"), '{"result":{"status":"failed","error":"Native rejection"}}');
  expect((await readTaskPreparations(root))[0]).toMatchObject({ stage: "failed", error: "Native rejection" });
  await writeFile(file("results"), '{"result":{"status":"accepted"}}');
  expect(await readTaskPreparations(root)).toEqual([]);
});
it("invalidates same-size edits, corrupt replacements and deletion instead of hiding them behind the cache", async () => {
  await writeFile(file("manual"), JSON.stringify(job("waiting")));
  await readTaskPreparations(root);
  await writeFile(file("manual"), JSON.stringify({ ...job("waiting"),
    request: { ...job("waiting").request, title: "Rewritten task" } }));
  expect((await readTaskPreparations(root))[0].title).toBe("Rewritten task");
  await writeFile(file("manual"), "{");
  await expect(readTaskPreparations(root)).rejects.toThrow();
  await writeFile(file("manual"), JSON.stringify(job("preparing")));
  expect((await readTaskPreparations(root))[0].stage).toBe("preparing");
  await rm(file("manual"));
  expect(await readTaskPreparations(root)).toEqual([]);
});
it("removes native accepted work from preparation instead of duplicating board cards", async () => {
  await writeFile(file("manual"), JSON.stringify(job("submitted")));
  await writeFile(file("results"), '{"result":{"status":"accepted","taskId":"manual-one"}}');
  expect(await readTaskPreparations(root)).toEqual([]);
  await rename(file("manual"), file("manual-history"));
  expect(await readTaskPreparations(root)).toEqual([]);
});
it("keeps preparation errors visible and retains native rejections after the runner archives the command", async () => {
  await writeFile(file("manual"), JSON.stringify({ ...job("failed"), detail: "Preparation refused" }));
  expect((await readTaskPreparations(root))[0]).toMatchObject({ stage: "failed", error: "Preparation refused" });
  await writeFile(file("results"), '{"result":{"status":"failed","error":"Native task creation refused"}}');
  await rename(file("manual"), file("manual-history"));
  expect((await readTaskPreparations(root))[0]).toMatchObject({ stage: "failed", error: "Native task creation refused" });
  expect((await readTaskPreparations(root))[0].error).toBe("Native task creation refused");
});
it("ignores non-creation commands and fails explicitly on corrupt task metadata", async () => {
  await writeFile(file("manual"), '{"request":{"kind":"status"}}');
  expect(await readTaskPreparations(root)).toEqual([]);
  await writeFile(file("manual"), '{"request":{"kind":"create"}}');
  await expect(readTaskPreparations(root)).rejects.toThrow("Invalid runner task preparation");
});
