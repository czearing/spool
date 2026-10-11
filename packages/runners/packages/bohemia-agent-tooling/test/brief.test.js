import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BRIEF_VERIFICATION,
  checkNumberInOutput,
  createReproductionVerifier,
  describeDrift,
  describeUnverifiedBrief,
  detectDrift,
  readNumbers,
  withinTolerance,
} from "../src/brief.js";
import { runCycle } from "../src/wake.js";
import { createTelemetryWriter } from "../src/telemetry.js";
import { defineCollector } from "../src/collect.js";
import { defineThresholdSelector } from "../src/select.js";
import { createMemoryQueue } from "../src/queue/memory-queue.js";

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

function harness({ observations, verifyBrief = null, defect = null, issues = [], minGapRatio = 0.1 }) {
  const dir = mkdtempSync(join(tmpdir(), "tooling-brief-"));
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
      verifyBrief,
      defect,
    },
  };
}

test("numbers are read out of command output with digit grouping removed", () => {
  assert.deepEqual(readNumbers("total 20,203,293 bytes over 1000000"), [20203293, 1000000]);
  assert.deepEqual(readNumbers(""), []);
  assert.deepEqual(readNumbers(null), []);
});

test("tolerance is a ratio of the expected number and zero means exact", () => {
  assert.equal(withinTolerance(100, 100, 0), true);
  assert.equal(withinTolerance(100, 101, 0), false);
  assert.equal(withinTolerance(100, 101, 0.02), true);
  assert.equal(withinTolerance(0, 0, 0), true);
});

test("a number the command never printed is not verified", () => {
  const missing = checkNumberInOutput(5242686, "eager bytes: 20203293");
  assert.equal(missing.verified, false);
  assert.deepEqual(missing.observed, [20203293]);

  const present = checkNumberInOutput(20203293, "eager bytes: 20203293");
  assert.equal(present.verified, true);
  assert.equal(present.matched, 20203293);
});

test("the verifier reports verified, unverified and unrunnable from the same run contract", async () => {
  const candidate = observation("a", 150, 100);

  const verified = await createReproductionVerifier({ run: async () => ({ ok: true, output: "value 150" }) })(candidate);
  assert.equal(verified.status, BRIEF_VERIFICATION.VERIFIED);

  const unverified = await createReproductionVerifier({ run: async () => ({ ok: true, output: "value 900" }) })(candidate);
  assert.equal(unverified.status, BRIEF_VERIFICATION.UNVERIFIED);
  assert.deepEqual(unverified.observed, [900]);

  const failed = await createReproductionVerifier({ run: async () => ({ ok: false, reason: "exit 1" }) })(candidate);
  assert.equal(failed.status, BRIEF_VERIFICATION.UNRUNNABLE);
  assert.equal(failed.reason, "exit 1");

  const threw = await createReproductionVerifier({
    run: async () => {
      throw new Error("command not found");
    },
  })(candidate);
  assert.equal(threw.status, BRIEF_VERIFICATION.UNRUNNABLE);

  const noCommand = await createReproductionVerifier({ run: async () => ({ ok: true, output: "150" }) })({
    ...candidate,
    reproduction: "",
  });
  assert.equal(noCommand.status, BRIEF_VERIFICATION.UNRUNNABLE);
});

test("the verifier requires a run function", () => {
  assert.throws(() => createReproductionVerifier({}), /run function/);
});

test("drift is only reported for an open task the current cycle measured again", () => {
  const openTasks = [
    { issueId: "i-1", metric: "a", current: 5242686 },
    { issueId: "i-2", metric: "b", current: 400 },
    { issueId: "i-3", metric: "c", current: 700 },
  ];
  const observations = [observation("a", 20203293, 250000), observation("b", 400, 100)];
  const drifts = detectDrift(openTasks, observations);

  assert.equal(drifts.length, 1);
  assert.equal(drifts[0].issueId, "i-1");
  assert.equal(drifts[0].recorded, 5242686);
  assert.equal(drifts[0].observed, 20203293);
  assert.equal(drifts[0].delta, 20203293 - 5242686);
  assert.match(describeDrift(drifts[0]), /brief is stale: a was written as 5242686 bytes and now measures 20203293 bytes/);
});

test("drift tolerance absorbs a measurement that did not move in any meaningful way", () => {
  const drifts = detectDrift([{ issueId: "i-1", metric: "a", current: 1000 }], [observation("a", 1005, 100)], {
    tolerance: 0.01,
  });
  assert.deepEqual(drifts, []);
});

test("a cycle refuses to write a task whose number its reproduction command does not produce", async () => {
  const h = harness({
    observations: [observation("a", 150, 100)],
    verifyBrief: createReproductionVerifier({ run: async () => ({ ok: true, output: "value 900" }) }),
    defect: { ownerAgentId: "owner-1" },
  });
  try {
    const summary = await runCycle(h.config);

    assert.equal(summary.empty, true);
    assert.equal(summary.issueId, null);
    assert.equal(summary.selection.reason, "brief_unverified");
    assert.equal(h.queue.created.length, 1);
    assert.equal(h.queue.created[0].assigneeAgentId, "owner-1");
    assert.match(h.queue.created[0].title, /^defect: brief refused: a current 150 bytes/);

    const cycle = h.telemetry.read().find((record) => record.kind === "cycle");
    assert.equal(cycle.issueId, null);
    assert.equal(cycle.briefVerification.status, "unverified");
    assert.equal(cycle.defectIssueId, summary.defectIssueId);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("a verified brief is written and the cycle records that it was verified", async () => {
  const h = harness({
    observations: [observation("a", 150, 100)],
    verifyBrief: createReproductionVerifier({ run: async () => ({ ok: true, output: "value 150" }) }),
    defect: { ownerAgentId: "owner-1" },
  });
  try {
    const summary = await runCycle(h.config);

    assert.equal(summary.empty, false);
    assert.equal(h.queue.created.length, 1);
    assert.equal(h.queue.created[0].assigneeAgentId, "agent-1");

    const cycle = h.telemetry.read().find((record) => record.kind === "cycle");
    assert.equal(cycle.briefVerification.status, "verified");
    assert.equal(cycle.defectIssueId, null);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("a cycle with no verifier still records that the brief was not checked", async () => {
  const h = harness({ observations: [observation("a", 150, 100)] });
  try {
    await runCycle(h.config);
    const cycle = h.telemetry.read().find((record) => record.kind === "cycle");
    assert.equal(cycle.briefVerification.status, "not_configured");
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("an open task whose number moved is corrected in place rather than handed to the tool owner", async () => {
  const h = harness({
    observations: [observation("a", 20203293, 250000)],
    defect: { ownerAgentId: "owner-1" },
    issues: [{ id: "mem-open", status: "in_progress", description: "metric: a" }],
  });
  try {
    h.telemetry.append("task_transition", {
      issueId: "mem-open",
      metric: "a",
      transition: "opened",
      current: 5242686,
      target: 250000,
      acceptance: 250000,
      unit: "bytes",
      reproduction: "node measure.js a",
    });

    const first = await runCycle(h.config);
    assert.equal(first.drifts.length, 1);
    assert.equal(first.issueId, null);
    assert.equal(first.corrections[0].result, "applied");
    assert.equal(first.defectIssueId, null);
    assert.equal(h.queue.created.length, 0);
    assert.match((await h.queue.getIssue("mem-open")).description, /current: 20203293 bytes/);

    const second = await runCycle(h.config);
    assert.equal(second.drifts.length, 0, "the corrected brief agrees with the collection");

    const drifted = h.telemetry.read().filter((record) => record.transition === "drifted");
    assert.equal(drifted.length, 1);
    assert.equal(drifted[0].observed, 20203293);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("a tool that turns correction off still reports a drifted brief once as a defect", async () => {
  const h = harness({
    observations: [observation("a", 20203293, 250000)],
    defect: { ownerAgentId: "owner-1" },
    issues: [{ id: "mem-open", status: "in_progress", description: "metric: a" }],
  });
  h.config.correctBriefs = false;
  try {
    h.telemetry.append("task_transition", {
      issueId: "mem-open",
      metric: "a",
      transition: "opened",
      current: 5242686,
      target: 250000,
      acceptance: 250000,
      unit: "bytes",
      reproduction: "node measure.js a",
    });

    const first = await runCycle(h.config);
    assert.equal(first.drifts.length, 1);
    assert.equal(h.queue.created.length, 1);
    assert.match(h.queue.created[0].title, /^defect: brief is stale: a was written as 5242686/);
    assert.equal(h.queue.created[0].parentId, "mem-open");

    const second = await runCycle(h.config);
    assert.equal(second.drifts.length, 1);
    assert.equal(h.queue.created.length, 1);

    const drifted = h.telemetry.read().filter((record) => record.transition === "drifted");
    assert.equal(drifted.length, 2);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("a defect channel without a tool owner is refused", async () => {
  const h = harness({ observations: [observation("a", 150, 100)], defect: { ownerAgentId: "" } });
  try {
    await assert.rejects(runCycle(h.config), /tool owner agent id/);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("the unverified defect wording names the numbers the command did produce", () => {
  const summary = describeUnverifiedBrief(observation("a", 150, 100), {
    status: BRIEF_VERIFICATION.UNVERIFIED,
    observed: [900, 901],
  });
  assert.match(summary, /a current 150 bytes was not produced by its reproduction command, which returned 900, 901/);
});
