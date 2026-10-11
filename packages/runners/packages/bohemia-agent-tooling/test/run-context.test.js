import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  ATTRIBUTED_WRITES,
  RUN_CONTEXT_REASONS,
  RUN_CONTEXT_REFUSAL_CODE,
  RunContextHeldError,
  describeUnattributableRun,
  guardIssueWrites,
  isRunContextRefusal,
  readRunContext,
} from "../src/run-context.js";

test("a run woken on an issue can attribute its writes", () => {
  const context = readRunContext({ PAPERCLIP_RUN_ID: "run-1", PAPERCLIP_TASK_ID: "issue-1" });
  assert.equal(context.attributable, true);
  assert.equal(context.reason, RUN_CONTEXT_REASONS.ATTRIBUTABLE);
  assert.equal(context.runId, "run-1");
  assert.equal(context.sourceIssueId, "issue-1");
});

test("a timer woken run carries a run and no source issue", () => {
  const context = readRunContext({ PAPERCLIP_RUN_ID: "run-1" });
  assert.equal(context.attributable, false);
  assert.equal(context.reason, RUN_CONTEXT_REASONS.NO_SOURCE_ISSUE);
  assert.equal(context.runId, "run-1");
  assert.equal(context.sourceIssueId, null);
});

test("a run with no run id at all is unattributable for a different reason", () => {
  const context = readRunContext({ PAPERCLIP_TASK_ID: "issue-1" });
  assert.equal(context.attributable, false);
  assert.equal(context.reason, RUN_CONTEXT_REASONS.NO_RUN_ID);
});

test("blank and missing reads are the same read", () => {
  assert.deepEqual(
    readRunContext({ PAPERCLIP_RUN_ID: "   ", PAPERCLIP_TASK_ID: "" }),
    readRunContext({}),
  );
});

test("the issue id key is read when the task id key is absent", () => {
  const context = readRunContext({ PAPERCLIP_RUN_ID: "run-1", PAPERCLIP_ISSUE_ID: "issue-2" });
  assert.equal(context.attributable, true);
  assert.equal(context.sourceIssueId, "issue-2");
});

test("the refusal is answered by code rather than by the sentence", () => {
  assert.equal(isRunContextRefusal({ code: RUN_CONTEXT_REFUSAL_CODE }), true);
  assert.equal(isRunContextRefusal({ details: { code: RUN_CONTEXT_REFUSAL_CODE } }), true);
  assert.equal(
    isRunContextRefusal(new Error(`queue PATCH failed with 403 (${RUN_CONTEXT_REFUSAL_CODE}): body`)),
    true,
  );
  assert.equal(isRunContextRefusal({ code: "issue_write_assignee_run_lock" }), false);
  assert.equal(isRunContextRefusal(null), false);
});

test("the sentence the control plane sends back is not read for the cause", () => {
  const sentence = new Error(
    "Cross-issue writes need a run to attribute them to (Heartbeat run context). Send the X-Paperclip-Run-Id header with your current run and retry.",
  );
  assert.equal(isRunContextRefusal(sentence), false);
  sentence.details = { code: RUN_CONTEXT_REFUSAL_CODE };
  assert.equal(isRunContextRefusal(sentence), true);
});

test("a held error is recognised without a code lookup", () => {
  const held = new RunContextHeldError("held", readRunContext({ PAPERCLIP_RUN_ID: "run-1" }));
  assert.equal(held.held, true);
  assert.equal(held.code, RUN_CONTEXT_REFUSAL_CODE);
  assert.equal(isRunContextRefusal(held), true);
});

function spyQueue() {
  const calls = [];
  return {
    calls,
    async createIssue(issue) {
      calls.push(["createIssue", issue]);
      return { id: "created" };
    },
    async getIssue(id) {
      calls.push(["getIssue", id]);
      return { id };
    },
    async listIssues() {
      calls.push(["listIssues"]);
      return [];
    },
    async updateIssue(id, update) {
      calls.push(["updateIssue", id, update]);
      return { id };
    },
    async cancelIssue(id) {
      calls.push(["cancelIssue", id]);
      return { id };
    },
    async parkIssue(id, park) {
      calls.push(["parkIssue", id, park]);
      return { id };
    },
  };
}

test("an attributable run is handed the queue it configured", () => {
  const queue = spyQueue();
  const guarded = guardIssueWrites(queue, readRunContext({ PAPERCLIP_RUN_ID: "r", PAPERCLIP_TASK_ID: "i" }));
  assert.equal(guarded, queue);
});

test("an unattributable run holds every write on an issue that already exists", async () => {
  const queue = spyQueue();
  const context = readRunContext({ PAPERCLIP_RUN_ID: "run-1" });
  const guarded = guardIssueWrites(queue, context);

  for (const name of ATTRIBUTED_WRITES) {
    const error = await guarded[name]("issue-1", { status: "done" }).then(
      () => null,
      (thrown) => thrown,
    );
    assert.equal(error?.held, true, `${name} was sent from an unattributable run`);
    assert.equal(error.code, RUN_CONTEXT_REFUSAL_CODE);
    assert.equal(error.runContext.reason, RUN_CONTEXT_REASONS.NO_SOURCE_ISSUE);
  }

  assert.deepEqual(queue.calls, [], "a held write must never reach the queue");
});

test("an unattributable run still reads and still opens new work", async () => {
  const queue = spyQueue();
  const guarded = guardIssueWrites(queue, readRunContext({ PAPERCLIP_RUN_ID: "run-1" }));

  assert.deepEqual(await guarded.getIssue("issue-1"), { id: "issue-1" });
  assert.deepEqual(await guarded.listIssues(), []);
  assert.deepEqual(await guarded.createIssue({ title: "t", description: "d" }), { id: "created" });
  assert.deepEqual(
    queue.calls.map((call) => call[0]),
    ["getIssue", "listIssues", "createIssue"],
  );
});

test("the run context is readable from the guarded queue", () => {
  const guarded = guardIssueWrites(spyQueue(), readRunContext({ PAPERCLIP_RUN_ID: "run-1" }));
  assert.equal(guarded.runContext.attributable, false);
});

test("a queue with no park surface is guarded for what it has", async () => {
  const queue = { async updateIssue() { return null; } };
  const guarded = guardIssueWrites(queue, readRunContext({}));
  assert.equal(typeof guarded.parkIssue, "undefined");
  await assert.rejects(() => guarded.updateIssue("a", {}), /held/);
});

test("the hold says which read was missing", () => {
  assert.match(
    describeUnattributableRun(readRunContext({ PAPERCLIP_RUN_ID: "run-1" })),
    /names no source issue/,
  );
  assert.match(describeUnattributableRun(readRunContext({})), /no run id/);
  assert.match(
    describeUnattributableRun(readRunContext({ PAPERCLIP_RUN_ID: "r", PAPERCLIP_TASK_ID: "i" })),
    /can attribute/,
  );
});

test("guarding refuses to run without both of its parts", () => {
  assert.throws(() => guardIssueWrites(null, readRunContext({})), /requires a queue/);
  assert.throws(() => guardIssueWrites(spyQueue(), null), /requires a run context/);
});
