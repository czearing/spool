import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTelemetryWriter, rollup, TELEMETRY_KINDS } from "../src/telemetry.js";

function tempPath() {
  const dir = mkdtempSync(join(tmpdir(), "tooling-telemetry-"));
  return { dir, path: join(dir, "nested", "cycles.jsonl") };
}

test("telemetry appends one json line per record and never rewrites earlier lines", () => {
  const { dir, path } = tempPath();
  try {
    const writer = createTelemetryWriter({ path, tool: "test-tool" });
    writer.append(TELEMETRY_KINDS.CYCLE, { observed: 2, issueId: null });
    writer.append(TELEMETRY_KINDS.TASK_TRANSITION, { issueId: "a", transition: "opened", metric: "m" });
    const records = writer.read();
    assert.equal(records.length, 2);
    assert.equal(records[0].kind, "cycle");
    assert.equal(records[0].tool, "test-tool");
    assert.equal(records[1].transition, "opened");
    assert.ok(Date.parse(records[0].ts) > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("telemetry preserves records written before it opened the file", () => {
  const { dir, path } = tempPath();
  try {
    const first = createTelemetryWriter({ path, tool: "test-tool" });
    first.append(TELEMETRY_KINDS.CYCLE, { observed: 1, issueId: null });
    const second = createTelemetryWriter({ path, tool: "test-tool" });
    second.append(TELEMETRY_KINDS.CYCLE, { observed: 3, issueId: null });
    assert.equal(second.read().length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("telemetry rejects an unknown kind and a non object payload", () => {
  const { dir, path } = tempPath();
  try {
    const writer = createTelemetryWriter({ path, tool: "test-tool" });
    assert.throws(() => writer.append("status_ping", {}), /telemetry kind/);
    assert.throws(() => writer.append(TELEMETRY_KINDS.CYCLE, "text"), /payload must be an object/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rollup derives open tasks, cycle counts and empty cycles from the log alone", () => {
  const { dir, path } = tempPath();
  try {
    const writer = createTelemetryWriter({ path, tool: "test-tool" });
    writer.append(TELEMETRY_KINDS.TASK_TRANSITION, {
      issueId: "i1",
      metric: "m1",
      transition: "opened",
      current: 10,
      target: 5,
      acceptance: 5,
    });
    writer.append(TELEMETRY_KINDS.CYCLE, { issueId: "i1" });
    writer.append(TELEMETRY_KINDS.CYCLE, { issueId: null });
    const open = rollup(writer.read());
    assert.equal(open.cycles, 2);
    assert.equal(open.emptyCycles, 1);
    assert.equal(open.issuesWritten, 1);
    assert.deepEqual(open.openTasks.map((task) => task.issueId), ["i1"]);

    writer.append(TELEMETRY_KINDS.TASK_TRANSITION, { issueId: "i1", metric: "m1", transition: "closed", verdict: "met" });
    assert.deepEqual(rollup(writer.read()).openTasks, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a drifted transition reports on an open task without closing it", () => {
  const { dir, path } = tempPath();
  try {
    const writer = createTelemetryWriter({ path, tool: "test-tool" });
    writer.append(TELEMETRY_KINDS.TASK_TRANSITION, {
      issueId: "i1",
      metric: "m1",
      transition: "opened",
      current: 10,
      target: 5,
      acceptance: 5,
    });
    writer.append(TELEMETRY_KINDS.TASK_TRANSITION, {
      issueId: "i1",
      metric: "m1",
      transition: "drifted",
      recorded: 10,
      observed: 40,
    });

    const state = rollup(writer.read());
    assert.deepEqual(state.openTasks.map((task) => task.issueId), ["i1"]);
    assert.equal(state.openTasks[0].current, 10);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("telemetry read tolerates a trailing partial newline written by another process", () => {
  const { dir, path } = tempPath();
  try {
    const writer = createTelemetryWriter({ path, tool: "test-tool" });
    writer.append(TELEMETRY_KINDS.CYCLE, { issueId: null });
    appendFileSync(path, "\n", "utf8");
    assert.equal(writer.read().length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a held correction keeps the task open and is counted apart from a deferral", () => {
  const records = [
    {
      kind: TELEMETRY_KINDS.TASK_TRANSITION,
      transition: "opened",
      issueId: "issue-1",
      metric: "m",
      current: 10,
      target: 5,
      acceptance: 5,
      ts: "2026-09-01T00:00:00.000Z",
    },
    { kind: TELEMETRY_KINDS.TASK_TRANSITION, transition: "drifted", issueId: "issue-1", metric: "m" },
    { kind: TELEMETRY_KINDS.TASK_TRANSITION, transition: "correction_held", issueId: "issue-1", metric: "m" },
    { kind: TELEMETRY_KINDS.TASK_TRANSITION, transition: "correction_held", issueId: "issue-1", metric: "m" },
  ];

  const state = rollup(records);
  assert.equal(state.heldCorrections, 2);
  assert.equal(state.deferredCorrections, 0);
  assert.equal(state.corrections, 0);
  assert.equal(state.openTasks.length, 1);
  assert.equal(state.openTasks[0].current, 10);
});
