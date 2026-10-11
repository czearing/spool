import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCycle, runWake } from "../src/wake.js";
import { createTelemetryWriter, rollup } from "../src/telemetry.js";
import { defineCollector } from "../src/collect.js";
import { defineThresholdSelector } from "../src/select.js";
import { createMemoryQueue } from "../src/queue/memory-queue.js";
import { guardIssueWrites, readRunContext } from "../src/run-context.js";

function observation(metric, current, target) {
  return {
    metric,
    current,
    target,
    acceptance: target,
    unit: "bytes",
    reproduction: `node measure.js ${metric}`,
  };
}

function harness({ observations, minGapRatio = 0.1, issues = [] }) {
  const dir = mkdtempSync(join(tmpdir(), "tooling-wake-"));
  const telemetry = createTelemetryWriter({ path: join(dir, "cycles.jsonl"), tool: "test-tool" });
  const queue = createMemoryQueue({ issues });
  return {
    dir,
    telemetry,
    queue,
    config: {
      tool: "test-tool",
      telemetry,
      queue,
      collectors: [defineCollector({ name: "demo", collect: () => observations })],
      selector: defineThresholdSelector({ minGapRatio }),
      assigneeAgentId: "agent-1",
      parentIssueId: "parent-1",
    },
  };
}

test("a full cycle collects, selects one candidate, writes one issue and appends telemetry", async () => {
  const h = harness({ observations: [observation("a", 150, 100), observation("b", 105, 100)] });
  try {
    const summary = await runCycle(h.config);
    assert.equal(summary.empty, false);
    assert.equal(summary.selection.candidate.metric, "a");
    assert.equal(h.queue.created.length, 1);

    const records = h.telemetry.read();
    assert.equal(records.filter((r) => r.kind === "cycle").length, 1);
    assert.equal(records.filter((r) => r.transition === "opened").length, 1);
    const cycle = records.find((r) => r.kind === "cycle");
    assert.equal(cycle.candidateMetric, "a");
    assert.equal(cycle.observed, 2);
    assert.equal(cycle.measurements.length, 2);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("an empty cycle writes a telemetry record and writes no issue", async () => {
  const h = harness({ observations: [observation("a", 101, 100)], minGapRatio: 0.5 });
  try {
    const summary = await runCycle(h.config);
    assert.equal(summary.empty, true);
    assert.equal(summary.issueId, null);
    assert.equal(h.queue.created.length, 0);
    const records = h.telemetry.read();
    assert.equal(records.length, 1);
    assert.equal(records[0].kind, "cycle");
    assert.equal(records[0].selectionReason, "no_observation_cleared_threshold");
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("a metric with an open task is not selected again on the next cycle", async () => {
  const h = harness({ observations: [observation("a", 150, 100)] });
  try {
    await runCycle(h.config);
    const second = await runCycle(h.config);
    assert.equal(second.empty, true);
    assert.equal(h.queue.created.length, 1);
    assert.deepEqual(second.cycleRecord.skippedOpenMetrics, ["a"]);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("the next wake reads the result back and records the task transition", async () => {
  const h = harness({ observations: [observation("a", 150, 100)] });
  try {
    const first = await runCycle(h.config);
    const issue = await h.queue.getIssue(first.issueId);
    issue.status = "done";
    issue.comments = [{ body: "after: 95" }];

    const second = await runCycle(h.config);
    const closed = h.telemetry.read().find((r) => r.transition === "closed");
    assert.equal(closed.verdict, "met");
    assert.equal(closed.after, 95);
    assert.equal(second.empty, false, "the metric is selectable again once the task closed");
    const open = rollup(h.telemetry.read()).openTasks;
    assert.equal(open.length, 1);
    assert.equal(open[0].issueId, second.issueId, "the closed task is no longer open");
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("a collection failure does not stop the cycle and is recorded", async () => {
  const h = harness({ observations: [observation("a", 150, 100)] });
  h.config.collectors = [
    ...h.config.collectors,
    defineCollector({
      name: "broken",
      collect: () => {
        throw new Error("repro command exited 1");
      },
    }),
  ];
  try {
    const summary = await runCycle(h.config);
    assert.equal(summary.failures.length, 1);
    assert.equal(summary.cycleRecord.collectionFailures[0].collector, "broken");
    assert.equal(summary.empty, false);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("the wake entry point prints one json summary and exits zero on an empty cycle", async () => {
  const h = harness({ observations: [observation("a", 101, 100)], minGapRatio: 0.5 });
  let out = "";
  try {
    const code = await runWake(h.config, { stdout: { write: (text) => (out += text) } });
    assert.equal(code, 0);
    const parsed = JSON.parse(out);
    assert.equal(parsed.empty, true);
    assert.equal(parsed.issueId, null);
    assert.equal(parsed.telemetryPath, h.telemetry.path);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("the wake entry point exits one when the cycle cannot run", async () => {
  const h = harness({ observations: [observation("a", 150, 100)] });
  let out = "";
  try {
    const code = await runWake({ ...h.config, selector: null }, { stdout: { write: (text) => (out += text) } });
    assert.equal(code, 1);
    assert.match(JSON.parse(out).error, /selector must be a function/);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("a gate that refuses appends a cycle record, collects nothing and writes no issue", async () => {
  const h = harness({ observations: [observation("a", 150, 100)] });
  let committed = null;
  h.config.collectors = [
    defineCollector({
      name: "must-not-run",
      collect: () => {
        throw new Error("collection ran behind a closed gate");
      },
    }),
  ];
  h.config.gate = {
    evaluate: () => ({ proceed: false, reason: "mark_unchanged", previous: "head-1", current: "head-1" }),
    commit: (outcome) => (committed = outcome),
  };
  try {
    const summary = await runCycle(h.config);
    assert.equal(summary.empty, true);
    assert.equal(summary.failures.length, 0);
    assert.equal(h.queue.created.length, 0);
    const records = h.telemetry.read();
    assert.equal(records.length, 1);
    assert.equal(records[0].kind, "cycle");
    assert.equal(records[0].selectionReason, "mark_unchanged");
    assert.equal(records[0].gate.proceed, false);
    assert.equal(committed.proceed, false);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("a gate that proceeds runs the whole cycle and records what it observed", async () => {
  const h = harness({ observations: [observation("a", 150, 100)] });
  let committed = null;
  h.config.gate = {
    evaluate: () => ({ proceed: true, reason: "relevant_change", previous: "head-1", current: "head-2" }),
    commit: (outcome) => (committed = outcome),
  };
  try {
    const summary = await runCycle(h.config);
    assert.equal(summary.empty, false);
    assert.equal(summary.cycleRecord.gate.current, "head-2");
    assert.equal(committed.issueId, summary.issueId);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("a tool supplied task renderer decides what the issue says", async () => {
  const h = harness({ observations: [observation("a", 150, 100)] });
  h.config.renderTask = (candidate) => ({
    title: `docs: ${candidate.metric}`,
    body: `set: one.md\nreader: a reader\ncurrent: ${candidate.current}`,
  });
  try {
    await runCycle(h.config);
    assert.equal(h.queue.created[0].title, "docs: a");
    assert.match(h.queue.created[0].description, /reader: a reader/);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("the wake summary names the run context it wrote from", async () => {
  const h = harness({ observations: [observation("a", 150, 100)] });
  let out = "";
  try {
    const timerWoken = guardIssueWrites(h.config.queue, readRunContext({ PAPERCLIP_RUN_ID: "run-1" }));
    const code = await runWake(
      { ...h.config, queue: timerWoken },
      { stdout: { write: (text) => (out += text) } },
    );
    assert.equal(code, 0);
    const parsed = JSON.parse(out);
    assert.equal(parsed.runContext, "no_source_issue");
    assert.equal(parsed.correctionsHeld, 0);
    assert.notEqual(parsed.issueId, null, "a timer woken cycle still opens the work it selected");
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("a cycle from a run woken on an issue reports an attributable context", async () => {
  const h = harness({ observations: [observation("a", 150, 100)] });
  try {
    const summary = await runCycle({
      ...h.config,
      runContext: readRunContext({ PAPERCLIP_RUN_ID: "run-1", PAPERCLIP_TASK_ID: "issue-1" }),
    });
    assert.equal(summary.runContext.attributable, true);
    assert.equal(summary.cycleRecord.runContext.reason, "attributable");
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});
