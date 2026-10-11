import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  createHandoffLedger,
  handoffFailures,
  handoffRollup,
  HANDOFF_TRANSITIONS,
} from "../src/handoff.js";

function makeLedger(clock = ["2026-09-01T00:00:00.000Z"]) {
  const path = join(mkdtempSync(join(tmpdir(), "handoff-")), "handoffs.jsonl");
  let index = 0;
  return createHandoffLedger({
    path,
    tool: "test-tool",
    now: () => new Date(clock[Math.min(index++, clock.length - 1)]),
  });
}

test("a handoff is one appended line carrying the task, the agent and the time", () => {
  const ledger = makeLedger();
  const record = ledger.append(HANDOFF_TRANSITIONS.HANDED, {
    taskKey: "pr:1:abc",
    agent: "PRReviewer",
    issueId: "issue-1",
    identifier: "OFF-1",
    title: "Review pull request 1",
  });
  assert.equal(record.at, "2026-09-01T00:00:00.000Z");
  assert.equal(record.tool, "test-tool");
  assert.equal(record.transition, "handed");
  const lines = readFileSync(ledger.path, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), record);
});

test("the ledger is append only across writes", () => {
  const ledger = makeLedger(["2026-09-01T00:00:00.000Z", "2026-09-01T00:05:00.000Z"]);
  ledger.append("handed", { taskKey: "a", agent: "PRReviewer" });
  ledger.append("closed", { taskKey: "a", agent: "PRReviewer" });
  assert.equal(ledger.read().length, 2);
  assert.deepEqual(ledger.read().map((entry) => entry.transition), ["handed", "closed"]);
});

test("an unnamed task or an unnamed recipient is refused at the write", () => {
  const ledger = makeLedger();
  assert.throws(() => ledger.append("handed", { agent: "PRReviewer" }), /taskKey/);
  assert.throws(() => ledger.append("handed", { taskKey: "a" }), /agent/);
  assert.throws(() => ledger.append("invented", { taskKey: "a", agent: "b" }), /transition must be/);
  assert.deepEqual(ledger.read(), []);
});

test("reading an absent ledger is empty rather than an error", () => {
  const path = join(mkdtempSync(join(tmpdir(), "handoff-")), "nested", "handoffs.jsonl");
  const ledger = createHandoffLedger({ path, tool: "test-tool" });
  assert.deepEqual(ledger.read(), []);
});

test("the rollup keeps one row per task and remembers when it was handed over", () => {
  const rows = handoffRollup([
    { at: "2026-09-01T00:00:00.000Z", taskKey: "a", agent: "PRReviewer", transition: "handed", issueId: "i1" },
    { at: "2026-09-01T00:10:00.000Z", taskKey: "a", agent: "PRReviewer", transition: "accepted" },
    { at: "2026-09-01T00:20:00.000Z", taskKey: "b", agent: "PRReviewer", transition: "handed", issueId: "i2" },
  ]);
  assert.equal(rows.length, 2);
  const [newest, older] = rows;
  assert.equal(newest.taskKey, "b");
  assert.equal(older.taskKey, "a");
  assert.equal(older.transition, "accepted");
  assert.equal(older.handedAt, "2026-09-01T00:00:00.000Z");
  assert.equal(older.issueId, "i1");
});

test("a refused handoff is reported as a failure even after other tasks succeed", () => {
  const failures = handoffFailures([
    { at: "2026-09-01T00:00:00.000Z", taskKey: "a", agent: "PRReviewer", transition: "handed" },
    { at: "2026-09-01T00:01:00.000Z", taskKey: "b", agent: "PRReviewer", transition: "refused", detail: "queue rejected" },
  ]);
  assert.deepEqual(failures.map((task) => task.taskKey), ["b"]);
  assert.equal(failures[0].detail, "queue rejected");
});
