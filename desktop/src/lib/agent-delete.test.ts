import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, afterEach, expect, it } from "vitest";
import { deleteAgent, listAgents, readAgentPrompt, saveAgentPrompt } from "./agents";

let root: string, file: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "spool-agent-delete-"));
  await mkdir(join(root, "agents")); file = join(root, "agents", "engineer.md");
  await writeFile(file, "# Engineer\n");
  await Promise.all(["incoming", "in_progress", "completed", "failed", ".runner-archive"].map((queue) => mkdir(join(root, "queues", queue), { recursive: true })));
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
it("removes only the selected configuration and keeps other agents, manifests and historical jobs", async () => {
  await writeFile(join(root, "agents", "reviewer.md"), "# Reviewer\n");
  await writeFile(join(root, "agents", "paperclip-prompts.json"), '{"historical":"unchanged"}');
  const paths = ["completed", "failed", ".runner-archive"].map((queue) => join(root, "queues", queue, "TASK-1.json"));
  await Promise.all(paths.map((path) => writeFile(path, '{"agent":"engineer","history":"untouched"}')));
  await deleteAgent(root, "engineer");
  expect(await listAgents(root)).toEqual(["reviewer"]);
  expect(await readdir(join(root, "agents"))).toEqual(["paperclip-prompts.json", "reviewer.md"]);
  expect(await readFile(join(root, "agents", "paperclip-prompts.json"), "utf8")).toBe('{"historical":"unchanged"}');
  for (const path of paths) expect(await readFile(path, "utf8")).toBe('{"agent":"engineer","history":"untouched"}');
});
it.each(["incoming", "in_progress"])("blocks deletion based on %s queue membership even if the record status is stale", async (queue) => {
  await writeFile(join(root, "queues", queue, "TASK-1.json"), '{"id":"TASK-1","agent":"engineer","status":"failed"}');
  await expect(deleteAgent(root, "engineer")).rejects.toMatchObject({ status: 409 });
  expect(await readFile(file, "utf8")).toBe("# Engineer\n");
  expect(await readdir(join(root, "agents"))).toEqual(["engineer.md"]);
});
it("does not block unrelated agents' work", async () => {
  await writeFile(join(root, "queues", "in_progress", "TASK-1.json"), '{"agent":"reviewer"}');
  await deleteAgent(root, "engineer"); expect(await listAgents(root)).toEqual([]);
});
it("respects an existing save lock without removing it", async () => {
  await writeFile(`${file}.lock`, "Owned by another save");
  await expect(deleteAgent(root, "engineer")).rejects.toMatchObject({ status: 409 });
  expect(await readFile(`${file}.lock`, "utf8")).toBe("Owned by another save");
  expect(await readFile(file, "utf8")).toBe("# Engineer\n");
});
it("blocks deletion while a native create command awaits scheduler acknowledgment", async () => {
  const pending = join(root, "controls", "requests"); await mkdir(pending, { recursive: true });
  await writeFile(join(pending, "create.json"), '{"kind":"create","agent":"engineer"}');
  await expect(deleteAgent(root, "engineer")).rejects.toMatchObject({ status: 409 });
  expect(await readFile(file, "utf8")).toBe("# Engineer\n");
});
it.each(["manual", "commands"])("blocks deletion during runner admission in %s, but not after definitive failure", async (directory) => {
  const pending = join(root, "controls", directory); await mkdir(pending, { recursive: true });
  await writeFile(join(pending, "create.json"), JSON.stringify({ request: { kind: "create", agent: "engineer" }, status: "preparing" }));
  await expect(deleteAgent(root, "engineer")).rejects.toMatchObject({ status: 409 });
  await mkdir(join(root, "controls", "results"));
  await writeFile(join(root, "controls", "results", "create.json"), '{"result":{"status":"failed","error":"Preparation failed"}}');
  await deleteAgent(root, "engineer");
  expect(await listAgents(root)).toEqual([]);
});
it.each(["../engineer", "..\\engineer", "engineer.md", "missing"])("never deletes an invalid or missing agent: %s", async (id) => {
  await expect(deleteAgent(root, id)).rejects.toMatchObject({ status: 404 });
  expect(await readFile(file, "utf8")).toBe("# Engineer\n");
});
it("does not resurrect a deleted agent when a stale editor saves", async () => {
  const document = await readAgentPrompt(root, "engineer");
  await deleteAgent(root, "engineer");
  await expect(saveAgentPrompt(root, "engineer", { ...document, prompt: "Stale draft" })).rejects.toMatchObject({ status: 404 });
  expect(await readdir(join(root, "agents"))).toEqual([]);
});
it("fails closed on unreadable pending state and releases its lock", async () => {
  await writeFile(join(root, "queues", "incoming", "TASK-1.json"), "{broken");
  await expect(deleteAgent(root, "engineer")).rejects.toThrow();
  expect(await readdir(join(root, "agents"))).toEqual(["engineer.md"]);
  await writeFile(join(root, "queues", "incoming", "TASK-1.json"), "{}");
  await expect(deleteAgent(root, "engineer")).rejects.toThrow("Cannot verify pending work");
});
it("allows deletion even if the prompt exceeds the editor's size limit", async () => {
  await writeFile(file, "x".repeat(140_000)); await deleteAgent(root, "engineer");
  expect(await listAgents(root)).toEqual([]);
});
it("rejects a linked agent directory and leaves its target untouched", async () => {
  const other = join(root, "other"); await mkdir(other);
  await symlink(join(root, "agents"), join(other, "agents"), "junction");
  await expect(deleteAgent(other, "engineer")).rejects.toMatchObject({ status: 400 });
  expect(await readFile(file, "utf8")).toBe("# Engineer\n");
});
