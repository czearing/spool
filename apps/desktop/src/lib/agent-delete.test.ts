import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, afterEach, expect, it } from "vitest";
import { deleteAgent, listAgents, readAgentPrompt, saveAgentPrompt } from "./agents";
import { configureApplication } from "./application-paths";
import { DELETE } from "../app/api/projects/[project]/agents/[agent]/route";

let root: string, file: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "spool-agent-delete-"));
  configureApplication({ data: root, resources: root });
  await writeFile(join(root, "projects.json"), JSON.stringify({ version: 1, projects: [{ id: "fixture", name: "Fixture", root }] }));
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
it.each(["incoming", "in_progress"])("deletes immediately with %s work and preserves the exact task record", async (queue) => {
  const task = join(root, "queues", queue, "TASK-1.json");
  const content = '{"id":"TASK-1","agent":"engineer","status":"failed","session_id":"existing-session"}';
  await writeFile(task, content);
  const response = await DELETE(new Request("http://localhost/api/projects/fixture/agents/engineer", {
    method: "DELETE", headers: { host: "localhost", origin: "http://localhost" },
  }), { params: Promise.resolve({ project: "fixture", agent: "engineer" }) });
  expect(response.status).toBe(204);
  expect(await readdir(join(root, "agents"))).toEqual([]);
  expect(await readFile(task, "utf8")).toBe(content);
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
it("deletes without waiting for a native create command acknowledgment", async () => {
  const pending = join(root, "controls", "requests"); await mkdir(pending, { recursive: true });
  await writeFile(join(pending, "create.json"), '{"kind":"create","agent":"engineer"}');
  await deleteAgent(root, "engineer");
  expect(await listAgents(root)).toEqual([]);
  expect(await readFile(join(pending, "create.json"), "utf8")).toBe('{"kind":"create","agent":"engineer"}');
});
it.each(["manual", "commands"])("deletes during runner admission in %s without changing its journal", async (directory) => {
  const pending = join(root, "controls", directory); await mkdir(pending, { recursive: true });
  const content = JSON.stringify({ request: { kind: "create", agent: "engineer" }, status: "preparing" });
  await writeFile(join(pending, "create.json"), content);
  await deleteAgent(root, "engineer");
  expect(await listAgents(root)).toEqual([]);
  expect(await readFile(join(pending, "create.json"), "utf8")).toBe(content);
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
it("does not read or modify malformed pending work when deleting an agent", async () => {
  const task = join(root, "queues", "incoming", "TASK-1.json");
  await writeFile(task, "{broken");
  await deleteAgent(root, "engineer");
  expect(await readdir(join(root, "agents"))).toEqual([]);
  expect(await readFile(task, "utf8")).toBe("{broken");
});
it("does not require queue directories or a running scheduler to delete an agent", async () => {
  await rm(join(root, "queues", "incoming"), { recursive: true });
  await deleteAgent(root, "engineer");
  expect(await readdir(join(root, "agents"))).toEqual([]);
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
