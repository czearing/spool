import { randomUUID } from "node:crypto";
import { readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { test, expect } from "./spool-task-fixture";

test.use({ interactive: true });
test.setTimeout(60000);
test("completed task restores persisted context in a new process, pins settings and sends only new text", async ({ page, projectServer: server, scheduler }) => {
  void scheduler;
  const id = "resume-task", code = randomUUID(), now = new Date().toISOString();
  const file = (queue: string) => join(server.bohemia, "queues", queue, `${id}.json`);
  const task = { id, title: "Resume isolated conversation", agent: "engineer", prompt: `remember-code: ${code}`,
    status: "incoming", created_at: now, updated_at: now };
  await writeFile(file("incoming"), JSON.stringify(task));
  await rm(join(server.bohemia, "controls", "paused", "engineer"));
  await expect.poll(async () => {
    try { return JSON.parse(await readFile(file("completed"), "utf8")).session_id; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }, { timeout: 15000 }).toBe("isolated-acp-session");
  const before = JSON.parse(await readFile(file("completed"), "utf8"));
  await scheduler.restart();
  await writeFile(join(server.bohemia, "agents", "engineer.md"), "---\nmodel: changed-default\nreasoning: high\n---\nChanged role.");
  const record = join(server.root, "agent-call.json");
  const first = JSON.parse(await readFile(record, "utf8"));
  await writeFile(`${record}.session.delay`, "");
  await page.goto(`${server.url}/bohemia/tasks`);
  await page.getByRole("button", { name: `Open conversation: ${task.title}` }).click();
  const dialog = page.getByRole("dialog"), input = dialog.getByRole("textbox", { name: "Message agent" });
  await expect(input).toHaveAttribute("aria-disabled", "false");
  await input.fill("Recall the code."); await input.press("Enter"); await expect(input).toBeEmpty();
  await expect.poll(async () => {
    try { return JSON.parse(await readFile(file("in_progress"), "utf8")).session_id; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }).toBe(before.session_id);
  await expect(dialog.getByText(`Fixture received: ${code}`, { exact: true })).toBeVisible({ timeout: 15000 });
  await expect.poll(async () => {
    try { return JSON.parse(await readFile(file("completed"), "utf8")).interaction.messages[0]?.status; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }).toBe("delivered");
  const after = JSON.parse(await readFile(file("completed"), "utf8"));
  const call = JSON.parse(await readFile(record, "utf8"));
  expect(after.session_id).toBe(before.session_id); expect(after.session_config).toEqual(before.session_config);
  expect(call.pid).not.toBe(first.pid); expect(call.prompts).toEqual(["Recall the code."]);
  const trace = (await readFile(`${record}.jsonl`, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  expect(trace.filter((request) => request.method === "session/new")).toHaveLength(1);
  expect(trace.filter((request) => request.method === "session/load")).toHaveLength(1);
  expect(trace.filter((request) => request.method === "session/set_config_option")).toHaveLength(0);
  const restored = trace.find((request) => request.method === "session/load");
  expect(restored.params.sessionId).toBe(before.session_id);
  expect(restored.args).toContain("unchanged-model"); expect(restored.args).not.toContain("changed-default");
  const transcript = await readFile(join(server.bohemia, "logs", `${id}.log`), "utf8");
  expect(transcript.split("\n").filter((line) => line.includes('"type":"user.message"'))).toHaveLength(2);
  // A failed task resumes using the same context, without replaying previously delivered messages.
  await rm(file("completed")); await writeFile(file("failed"), JSON.stringify({ ...after, status: "failed", error: "Fixture failure" }));
  const url = `${server.url}/api/projects/bohemia/tasks/${id}/conversation`;
  const recovery = { id: randomUUID(), message: "Continue after failure." };
  expect((await page.request.post(url, { data: recovery, headers: { Origin: server.url } })).status()).toBe(200);
  await expect.poll(async () => {
    try { return JSON.parse(await readFile(file("completed"), "utf8")).interaction.messages.at(-1)?.status; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }, { timeout: 15000 }).toBe("delivered");
  expect(JSON.parse(await readFile(record, "utf8")).prompts).toEqual([recovery.message]);
  const recovered = JSON.parse(await readFile(file("completed"), "utf8"));
  expect(recovered.error).toBeNull(); expect(recovered.session_id).toBe(before.session_id);
  // A missing provider session must never create a replacement.
  await rm(`${record}.session`);
  const command = { id: randomUUID(), message: "Restore without replacing the conversation." };
  const response = await page.request.post(url, { data: command, headers: { Origin: server.url } });
  expect(response.status()).toBe(200);
  await expect.poll(async () => {
    try { return JSON.parse(await readFile(file("failed"), "utf8")).error; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error; }
  }, { timeout: 15000 }).toContain("Saved session unavailable");
  const failed = JSON.parse(await readFile(file("failed"), "utf8"));
  expect(failed.session_id).toBe(before.session_id);
  expect(failed.interaction.messages.at(-1).text).toBe(command.message);
  const retried = await page.request.post(url, { data: command, headers: { Origin: server.url } });
  expect(retried.status()).toBe(200);
  const requests = (await readFile(`${record}.jsonl`, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  expect(requests.filter((request) => request.method === "session/new")).toHaveLength(1);
  expect(requests.filter((request) => request.method === "session/prompt")).toHaveLength(3);
});
