import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMarkStore, defineChangeGate, assertGate } from "../src/gate.js";

function store() {
  const dir = mkdtempSync(join(tmpdir(), "tooling-gate-"));
  return { dir, store: createMarkStore({ path: join(dir, "state", "mark.json") }) };
}

test("a first run proceeds because there is no mark yet", async () => {
  const s = store();
  try {
    const gate = defineChangeGate({ store: s.store, readCurrent: () => "head-1" });
    const result = await gate.evaluate();
    assert.equal(result.proceed, true);
    assert.equal(result.reason, "first_run");
    assert.equal(result.previous, null);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("an unchanged mark refuses the cycle and never rewrites the state", async () => {
  const s = store();
  try {
    const gate = defineChangeGate({ store: s.store, readCurrent: () => "head-1" });
    await gate.evaluate();
    gate.commit({ proceed: true });
    const before = s.store.read();

    const second = await gate.evaluate();
    assert.equal(second.proceed, false);
    assert.equal(second.reason, "mark_unchanged");
    gate.commit({ proceed: false });
    assert.deepEqual(s.store.read(), before);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("a mark that moved with no relevant change refuses the cycle and still advances the mark", async () => {
  const s = store();
  let head = "head-1";
  try {
    const gate = defineChangeGate({
      store: s.store,
      readCurrent: () => head,
      isRelevant: ({ current }) => ({ relevant: current === "head-3", detail: { changed: [] } }),
    });
    await gate.evaluate();
    gate.commit({ proceed: true });

    head = "head-2";
    const second = await gate.evaluate();
    assert.equal(second.proceed, false);
    assert.equal(second.reason, "no_relevant_change");
    gate.commit({ proceed: false });
    assert.equal(s.store.read().mark, "head-2", "an irrelevant change is not measured twice");
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("a mark that moved with a relevant change proceeds", async () => {
  const s = store();
  let head = "head-1";
  try {
    const gate = defineChangeGate({
      store: s.store,
      readCurrent: () => head,
      isRelevant: () => ({ relevant: true, detail: { changed: ["docs/a.md"] } }),
    });
    await gate.evaluate();
    gate.commit({ proceed: true });

    head = "head-2";
    const second = await gate.evaluate();
    assert.equal(second.proceed, true);
    assert.equal(second.reason, "relevant_change");
    assert.equal(second.previous, "head-1");
    assert.deepEqual(second.detail.changed, ["docs/a.md"]);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("the mark is held back when the tool says the change was not accounted for", async () => {
  const s = store();
  try {
    const gate = defineChangeGate({
      store: s.store,
      readCurrent: () => "head-1",
      shouldAdvance: (outcome) => outcome.selection?.reason !== "max_open_tasks_reached",
    });
    await gate.evaluate();
    gate.commit({ proceed: true, selection: { reason: "max_open_tasks_reached" } });
    assert.equal(existsSync(s.store.path), false, "a deferred change leaves no mark behind");

    await gate.evaluate();
    gate.commit({ proceed: true, selection: { reason: "largest_gap_above_threshold" } });
    assert.equal(s.store.read().mark, "head-1");
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("a mark that cannot be read refuses the cycle rather than guessing one", async () => {
  const s = store();
  try {
    const gate = defineChangeGate({ store: s.store, readCurrent: () => null });
    const result = await gate.evaluate();
    assert.equal(result.proceed, false);
    assert.equal(result.reason, "current_mark_unreadable");
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("a bypassed run proceeds on an unchanged mark and still records the mark it observed", async () => {
  const s = store();
  try {
    const first = defineChangeGate({ store: s.store, readCurrent: () => "head-1" });
    await first.evaluate();
    first.commit({ proceed: true });

    let relevanceAsked = false;
    const forced = defineChangeGate({
      store: s.store,
      readCurrent: () => "head-1",
      isRelevant: () => {
        relevanceAsked = true;
        return { relevant: false };
      },
      bypass: true,
    });
    const result = await forced.evaluate();
    assert.equal(result.proceed, true);
    assert.equal(result.reason, "bypassed");
    assert.equal(result.previous, "head-1");
    assert.equal(relevanceAsked, false, "a bypassed run never asks the relevance rule");

    forced.commit({ proceed: true });
    assert.equal(s.store.read().mark, "head-1", "a forced run leaves a mark the next run can diff from");

    const next = defineChangeGate({ store: s.store, readCurrent: () => "head-1" });
    const after = await next.evaluate();
    assert.equal(after.reason, "mark_unchanged", "a forced run does not poison the next comparison");
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("a gate without an evaluate function is refused", () => {
  assert.throws(() => assertGate({}), /evaluate/);
  assert.throws(() => assertGate({ evaluate: () => {}, commit: 3 }), /commit/);
  assert.equal(assertGate(null), null);
});
