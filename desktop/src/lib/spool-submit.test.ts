import * as fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readSpoolSubmission, submitSpoolTask } from "./spool-submit";
import { validateSubmission, type TaskSubmission } from "./task-submission";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, link: vi.fn(actual.link), rename: vi.fn(actual.rename) };
});
const actual = await vi.importActual<typeof fs>("node:fs/promises");
let root: string, input: TaskSubmission;
const control = (...parts: string[]) => join(root, "controls", ...parts);
const queue = (status = "incoming") => join(root, "queues", status, `manual-${input.requestId}.json`);
beforeEach(async () => {
  vi.mocked(fs.link).mockReset().mockImplementation(actual.link);
  vi.mocked(fs.rename).mockReset().mockImplementation(actual.rename);
  root = await fs.mkdtemp(join(tmpdir(), "spool-submit-"));
  await fs.mkdir(join(root, "agents")); await fs.mkdir(control());
  for (const status of ["incoming", "in_progress", "completed", "failed"]) await fs.mkdir(join(root, "queues", status), { recursive: true });
  await fs.writeFile(join(root, "agents", "engineer.md"), "# Instructions");
  await fs.writeFile(control("capabilities.json"), JSON.stringify({ taskControl: true, updatedAt: new Date().toISOString() }));
  input = { requestId: randomUUID(), agent: "engineer", title: "A new task", prompt: "Do **careful** work!" };
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
it("publishes an actual native work item immediately with no repository setup or runner service", async () => {
  const response = await submitSpoolTask(root, input);
  expect(response).toEqual({ id: `manual-${input.requestId}`, state: "accepted", notice: "Queued for agent" });
  expect(JSON.parse(await fs.readFile(queue(), "utf8"))).toMatchObject({
    id: response.id, agent: input.agent, title: input.title, prompt: input.prompt, workspace: null,
    status: "incoming", session_id: null, independent_workspace: false, interaction: { applied_requests: [input.requestId] },
  });
  expect(await fs.readdir(control())).toEqual(["capabilities.json", "ui-submissions"]);
  expect(await fs.readdir(join(root, "agents"))).toEqual(["engineer.md"]);
});
it("publishes supported model preferences without altering the agent or duplicating retries", async () => {
  await fs.writeFile(control("capabilities.json"), JSON.stringify({ taskControl: true, taskModelVersion: 1, updatedAt: new Date().toISOString() }));
  const draft = { ...input, model: "preferred-model" };
  await submitSpoolTask(root, draft);
  expect(JSON.parse(await fs.readFile(queue(), "utf8")).model).toBe("preferred-model");
  expect(await fs.readFile(join(root, "agents", "engineer.md"), "utf8")).toBe("# Instructions");
  expect((await submitSpoolTask(root, draft)).state).toBe("accepted");
  await expect(submitSpoolTask(root, { ...draft, model: "changed-model" })).rejects.toMatchObject({ status: 409 });
});
it("rejects model selection explicitly when the daemon cannot honor it", async () => {
  await expect(submitSpoolTask(root, { ...input, model: "preferred-model" })).rejects.toMatchObject({ status: 503, rejected: true });
  expect(await fs.readdir(join(root, "queues", "incoming"))).toEqual([]);
});
it("reuses publication even after execution, archiving or an offline daemon", async () => {
  const first = await submitSpoolTask(root, input);
  await fs.rename(queue(), queue("completed"));
  await fs.rm(control("capabilities.json"));
  expect(await submitSpoolTask(root, input)).toEqual(first);
  await fs.rm(queue("completed"));
  expect(await submitSpoolTask(root, input)).toEqual(first);
  expect(await fs.readdir(join(root, "queues", "incoming"))).toEqual([]);
  await expect(submitSpoolTask(root, { ...input, prompt: "Changed" })).rejects.toMatchObject({ status: 409 });
});
it("recovers a lost publication receipt after the daemon has already moved the task", async () => {
  vi.mocked(fs.rename).mockRejectedValueOnce(new Error("Receipt write interrupted"));
  await expect(submitSpoolTask(root, input)).rejects.toThrow("Receipt write interrupted");
  await actual.rename(queue(), queue("in_progress"));
  expect((await submitSpoolTask(root, input)).state).toBe("accepted");
  expect(await fs.readdir(join(root, "queues", "incoming"))).toEqual([]);
  expect(await readSpoolSubmission(root, input.requestId)).toMatchObject({ state: "accepted" });
});
it("cleans a definitively failed publication and allows the same request to retry", async () => {
  vi.mocked(fs.link).mockImplementation(async (source, destination) => {
    if (String(destination) === queue()) throw Object.assign(new Error("Disk full"), { code: "ENOSPC" });
    return actual.link(source, destination);
  });
  await expect(submitSpoolTask(root, input)).rejects.toThrow("Disk full");
  expect(await fs.readdir(control("ui-submissions"))).toEqual([]);
  expect(await fs.readdir(join(root, "queues", "incoming"))).toEqual([]);
  vi.mocked(fs.link).mockImplementation(actual.link);
  expect((await submitSpoolTask(root, input)).state).toBe("accepted");
});
it("never recreates uncertain or foreign tasks", async () => {
  await fs.writeFile(queue(), '{"id":"foreign"}');
  await expect(submitSpoolTask(root, input)).rejects.toThrow("Invalid Spool work item");
  expect(await fs.readFile(queue(), "utf8")).toBe('{"id":"foreign"}');
  await fs.rm(queue()); await submitSpoolTask(root, input);
  const file = control("ui-submissions", `${input.requestId}.json`);
  const receipt = JSON.parse(await fs.readFile(file, "utf8"));
  await fs.writeFile(file, JSON.stringify({ ...receipt, phase: "reserved" })); await fs.rm(queue());
  await expect(submitSpoolTask(root, input)).rejects.toMatchObject({ status: 503 });
  expect(await fs.readdir(join(root, "queues", "incoming"))).toEqual([]);
});
it("will not duplicate a legacy runner request", async () => {
  await fs.mkdir(control("commands")); await fs.writeFile(control("commands", `${input.requestId}.json`), "{}");
  await expect(submitSpoolTask(root, input)).rejects.toMatchObject({ status: 409 });
  expect(await fs.readdir(join(root, "queues", "incoming"))).toEqual([]);
});
it("allows paused agents to receive queued work without changing pause state", async () => {
  await fs.mkdir(control("paused")); await fs.writeFile(control("paused", "engineer"), "Paused by operator");
  expect((await submitSpoolTask(root, input)).state).toBe("accepted");
  expect(await fs.readFile(control("paused", "engineer"), "utf8")).toBe("Paused by operator");
});
it("requires a live scheduler and shares the agent mutation lock", async () => {
  const lock = join(root, "agents", "engineer.md.lock"); await fs.writeFile(lock, "Other operation");
  await expect(submitSpoolTask(root, input)).rejects.toMatchObject({ status: 409 });
  expect(await fs.readFile(lock, "utf8")).toBe("Other operation"); await fs.rm(lock);
  await fs.writeFile(control("capabilities.json"), '{"taskControl":true,"updatedAt":"2000-01-01T00:00:00Z"}');
  await expect(submitSpoolTask(root, input)).rejects.toMatchObject({ status: 503 });
  expect(await fs.readdir(join(root, "agents"))).toEqual(["engineer.md"]);
});
it("accepts long instructions without command-line truncation", async () => {
  const prompt = "a".repeat(120000); await submitSpoolTask(root, { ...input, prompt });
  expect(JSON.parse(await fs.readFile(queue(), "utf8")).prompt).toBe(prompt);
});
it("rejects missing agents, workspace overrides and unknown receipts", async () => {
  await expect(submitSpoolTask(root, { ...input, agent: "missing" })).rejects.toMatchObject({ status: 404 });
  await expect(submitSpoolTask(root, { ...input, workspace: root })).rejects.toMatchObject({ status: 400 });
  await expect(readSpoolSubmission(root, input.requestId)).rejects.toMatchObject({ status: 404 });
});
it.each([{ title: " " }, { prompt: "" }, { agent: "../engineer" }, { agent: "_engineer" }, { requestId: "../../bad" },
  { prompt: "\0" }, { title: "é".repeat(251) }, { prompt: "x".repeat(120001) }, { model: "bad model" }, { model: "--evil" }])("validates fields and byte limits: %j", (fields) => {
  expect(() => validateSubmission({ ...input, ...fields })).toThrow();
});
