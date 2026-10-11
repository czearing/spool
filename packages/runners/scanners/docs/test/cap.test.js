import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTelemetryWriter, defineOpenCapSelector, TELEMETRY_KINDS } from "../../../packages/bohemia-agent-tooling/src/index.js";
import { countOpenTasksFrom } from "../config.js";
import { openTasks } from "../open-tasks.js";
import { defineDocsSelector } from "../select.js";
import { reproductionCommand } from "../metrics.js";

function observation(setKey, overage) {
  return {
    metric: `docs.set:${setKey}`,
    current: overage,
    target: 0,
    acceptance: 0,
    unit: "budget overages",
    reproduction: reproductionCommand(["a.md"]),
    setKey,
    readerId: "reader-a",
    files: [{ path: "a.md", overage, metrics: [] }],
  };
}

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "docs-cap-"));
  const telemetry = createTelemetryWriter({ path: join(dir, "cycles.jsonl"), tool: "docs-engine" });
  const selector = defineOpenCapSelector({
    selector: defineDocsSelector({ minOverage: 1 }),
    countOpen: countOpenTasksFrom(telemetry),
    maxOpenTasks: 1,
  });
  return { dir, telemetry, selector };
}

test("with nothing open the cap lets the worst set through", () => {
  const h = harness();
  try {
    const selection = h.selector([observation("one", 4), observation("two", 9)]);
    assert.equal(selection.candidate.setKey, "two");
    assert.equal(selection.openTasks, 0);
    assert.equal(selection.maxOpenTasks, 1);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("at the cap no set is selected and the ranking is still recorded", () => {
  const h = harness();
  try {
    h.telemetry.append(TELEMETRY_KINDS.TASK_TRANSITION, {
      issueId: "issue-1",
      metric: "docs.set:one",
      transition: "opened",
      current: 4,
      target: 0,
      acceptance: 0,
    });
    const selection = h.selector([observation("two", 9)]);
    assert.equal(selection.candidate, null);
    assert.equal(selection.reason, "max_open_tasks_reached");
    assert.equal(selection.openTasks, 1);
    assert.equal(selection.ranked[0].set, "two", "what is waiting behind the cap is still visible");
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("a task that closed in the same run frees its slot", () => {
  const h = harness();
  try {
    h.telemetry.append(TELEMETRY_KINDS.TASK_TRANSITION, {
      issueId: "issue-1",
      metric: "docs.set:one",
      transition: "opened",
      current: 4,
      target: 0,
      acceptance: 0,
    });
    assert.equal(h.selector([observation("two", 9)]).candidate, null);

    h.telemetry.append(TELEMETRY_KINDS.TASK_TRANSITION, {
      issueId: "issue-1",
      metric: "docs.set:one",
      transition: "closed",
      verdict: "met",
      after: 0,
    });
    const selection = h.selector([observation("two", 9)]);
    assert.equal(selection.candidate.setKey, "two");
    assert.equal(selection.openTasks, 0);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("a set under the overage floor is never selected", () => {
  const selector = defineDocsSelector({ minOverage: 4 });
  const selection = selector([observation("one", 3)]);
  assert.equal(selection.candidate, null);
  assert.equal(selection.reason, "no_document_set_over_budget");
  assert.throws(() => defineDocsSelector({ minOverage: 0 }), /at least 1/);
});

test("a task the queue could not be read for keeps holding its slot", () => {
  const h = harness();
  try {
    h.telemetry.append(TELEMETRY_KINDS.TASK_TRANSITION, {
      issueId: "issue-1",
      metric: "docs.set:one",
      transition: "opened",
      current: 4,
      target: 0,
      acceptance: 0,
    });
    h.telemetry.append(TELEMETRY_KINDS.TASK_TRANSITION, {
      issueId: "issue-1",
      metric: "docs.set:one",
      transition: "unreadable",
      verdict: "unknown",
      error: "queue GET failed with 503",
    });

    const held = openTasks(h.telemetry.read());
    assert.equal(held.length, 1);
    assert.equal(held[0].held, true);
    assert.equal(h.selector([observation("two", 9)]).reason, "max_open_tasks_reached");
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});
