import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTaskIssue,
  buildDefectIssue,
  writeTaskIssue,
  writeDefectIssue,
  DEFAULT_BODY_BUDGET,
} from "../src/issue-writer.js";
import { createMemoryQueue } from "../src/queue/memory-queue.js";

const candidate = {
  metric: "demo.startup-graph.bytes",
  current: 1234567,
  target: 900000,
  acceptance: 900000,
  unit: "bytes",
  reproduction: "node measure.js demo.startup-graph.bytes",
};

test("a task body carries the five values and nothing else", () => {
  const { title, body } = buildTaskIssue(candidate);
  assert.match(title, /^perf: demo\.startup-graph\.bytes 1234567 to 900000 bytes$/);
  assert.match(body, /^metric: demo\.startup-graph\.bytes$/m);
  assert.match(body, /^current: 1234567 bytes$/m);
  assert.match(body, /^target: 900000 bytes$/m);
  assert.match(body, /^acceptance: .*900000 bytes$/m);
  assert.match(body, /^reproduction: node measure\.js demo\.startup-graph\.bytes$/m);
  assert.match(body, /^after: <number>$/m);
});

test("a task body includes clean branch and workspace instructions when branchName is provided", () => {
  const { body } = buildTaskIssue({
    ...candidate,
    branchName: "user/calebzearing/perf-demo-startup-graph",
    repoRoot: "C:\\Code\\bohemia\\office-bohemia-perf-agent",
  });
  assert.match(body, /The branch `user\/calebzearing\/perf-demo-startup-graph` is checked out in `C:\\Code\\bohemia\\office-bohemia-perf-agent` and verified clean\./);
  assert.match(body, /Do not run git checkout, fetch, reset, or clean; proceed directly to your optimizations\./);
});

test("a task body stays under the character budget the adapter can pass", () => {
  const { body, title } = buildTaskIssue({
    ...candidate,
    metric: "demo." + "a".repeat(60),
    reproduction: "node " + "b".repeat(300) + "\\measure.js",
  });
  assert.ok(body.length <= DEFAULT_BODY_BUDGET, `body was ${body.length}`);
  assert.ok(title.length <= 120, `title was ${title.length}`);
});

test("a body over the budget is refused instead of written", () => {
  assert.throws(
    () => buildTaskIssue({ ...candidate, reproduction: "x".repeat(2000) }),
    /task body is \d+ characters, budget is 900/,
  );
});

test("a task with no current number is impossible to write", async () => {
  const queue = createMemoryQueue();
  assert.throws(() => buildTaskIssue({ ...candidate, current: null }), /without a finite current number/);
  await assert.rejects(
    () => writeTaskIssue({ queue, candidate: { ...candidate, current: undefined }, assigneeAgentId: "agent-1" }),
    /without a finite current number/,
  );
  assert.equal(queue.created.length, 0);
});

test("a task issue is written to the queue assigned to the configured agent", async () => {
  const queue = createMemoryQueue();
  const created = await writeTaskIssue({
    queue,
    candidate,
    assigneeAgentId: "agent-1",
    parentIssueId: "parent-1",
  });
  assert.equal(queue.created.length, 1);
  assert.equal(created.assigneeAgentId, "agent-1");
  assert.equal(created.parentId, "parent-1");
  assert.equal(created.status, "todo");
});

test("writing a task requires an assignee and a queue", async () => {
  await assert.rejects(() => writeTaskIssue({ queue: createMemoryQueue(), candidate }), /assignee agent id/);
  await assert.rejects(() => writeTaskIssue({ candidate, assigneeAgentId: "a" }), /queue with createIssue/);
});

test("a defect issue is one child issue routed to the tool owner", async () => {
  const queue = createMemoryQueue();
  const created = await writeDefectIssue({
    queue,
    defect: { tool: "perf-engine", surface: "selection", summary: "selection picked a metric with an open task", detailPath: "C:\\logs\\defect.md" },
    ownerAgentId: "owner-1",
    parentIssueId: "task-1",
  });
  assert.equal(created.assigneeAgentId, "owner-1");
  assert.equal(created.parentId, "task-1");
  assert.match(created.description, /^surface: selection$/m);
  assert.match(created.description, /^detail: C:\\logs\\defect\.md$/m);
  assert.equal(queue.created.length, 1);
});

test("a defect without a summary and a defect body over budget are refused", () => {
  assert.throws(() => buildDefectIssue({ summary: "" }), /without a summary/);
  assert.throws(() => buildDefectIssue({ summary: "x".repeat(2000) }), /defect body is \d+ characters/);
});

test("a supplied renderer decides the wording and still cannot skip the numbers", () => {
  const renderTask = (input) => ({
    title: `docs: ${input.metric}`,
    body: `set: ${input.files?.join(" ")}\ncurrent: ${input.current}\nbudget: ${input.target}`,
  });
  const built = buildTaskIssue({ ...candidate, files: ["a.md", "b.md"] }, { renderTask });
  assert.equal(built.title, "docs: demo.startup-graph.bytes");
  assert.match(built.body, /set: a.md b.md/);

  assert.throws(() => buildTaskIssue({ ...candidate, current: undefined }, { renderTask }), /current number/);
  assert.throws(() => buildTaskIssue(candidate, { renderTask: () => ({ title: "", body: "x" }) }), /non empty/);
  assert.throws(() => buildTaskIssue(candidate, { renderTask: "no" }), /renderTask must be a function/);
});

test("a supplied renderer is held to the same body budget", () => {
  const renderTask = () => ({ title: "docs: long", body: "x".repeat(DEFAULT_BODY_BUDGET + 1) });
  assert.throws(() => buildTaskIssue(candidate, { renderTask }), /body is/);
});

test("the queue receives the rendered body when a renderer is passed through the writer", async () => {
  const queue = createMemoryQueue();
  await writeTaskIssue({
    queue,
    candidate,
    assigneeAgentId: "agent-1",
    renderTask: () => ({ title: "docs: set", body: "reader: an operator" }),
  });
  assert.equal(queue.created[0].title, "docs: set");
  assert.equal(queue.created[0].description, "reader: an operator");
});

test("a task issue carries the project it belongs to, so the agent gets a checkout", async () => {
  const written = [];
  const queue = { createIssue: async (issue) => { written.push(issue); return { id: "issue-1" }; } };
  await writeTaskIssue({
    queue,
    candidate,
    assigneeAgentId: "agent-1",
    projectId: "project-1",
  });
  assert.equal(written.length, 1);
  assert.equal(written[0].projectId, "project-1");
});

test("a task issue written by a tool with no project names none rather than an empty one", async () => {
  const written = [];
  const queue = { createIssue: async (issue) => { written.push(issue); return { id: "issue-1" }; } };
  await writeTaskIssue({ queue, candidate, assigneeAgentId: "agent-1" });
  assert.equal(written[0].projectId, undefined);
});
