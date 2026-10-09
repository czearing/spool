import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, afterEach, expect, it } from "vitest";
import { readTaskPreparations } from "./task-preparations";

let root: string;
const job = (status: string) => ({ status, request: { kind: "create", taskId: "manual-one", title: "Requested task", agent: "engineer", prompt: "PRIVATE" } });
const file = (folder: string, name = "one") => join(root, "controls", folder, `${name}.json`);
beforeEach(async () => {
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
