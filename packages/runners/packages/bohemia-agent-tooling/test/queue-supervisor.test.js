import test from "node:test";
import assert from "node:assert/strict";
import { createQueueSupervisor } from "../src/queue-supervisor.js";

function fixture(prepareTask, changed = false) {
  const task = { id: "task", identifier: "OFF-1", projectId: "project", assigneeAgentId: "agent", status: "backlog" };
  const events = [];
  const errors = [];
  const supervisor = createQueueSupervisor({
    apiUrl: "http://fixture", companyId: "company", agentId: "agent", projectId: "project", prepareTask,
    logger: message => errors.push(message),
    fetchImpl: async (url, options = {}) => {
      if (options.method === "PATCH") {
        events.push("promote"); Object.assign(task, JSON.parse(options.body));
        return { ok: true, json: async () => ({ ...task }) };
      }
      if (options.method === "POST") { events.push("wake"); return { ok: true }; }
      const body = url.endsWith("/issues") ? [task]
        : url.endsWith("/issues/task") ? { ...task, ...(changed ? { assigneeAgentId: "other" } : {}) }
        : { status: "running" };
      return { ok: true, json: async () => body };
    },
  });
  return { supervisor, task, events, errors };
}

test("backlog preparation completes before promotion and waking", async () => {
  const f = fixture(async () => { f.events.push("prepare"); return { projectWorkspaceId: "prepared" }; });
  await f.supervisor.step();
  assert.deepEqual(f.events, ["prepare", "promote", "wake"]);
  assert.equal(f.task.projectWorkspaceId, "prepared");
});
test("preparation failure or changed ownership cannot promote or wake", async () => {
  for (const changed of [false, true]) {
    const f = fixture(async () => { if (!changed) throw new Error("installation failed"); return {}; }, changed);
    await assert.rejects(f.supervisor.step(), /installation failed|ownership changed/);
    assert.deepEqual(f.events, []);
    assert.equal(f.task.status, "backlog");
  }
});
