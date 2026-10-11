import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readState, writeJsonAtomic } from "../lib/state.mjs";

test("reads initial state when file does not exist", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "livesite-state-test-"));
  try {
    const state = await readState(path.join(dir, "nonexistent.json"));
    assert.deepEqual(state, { alerts: {}, lastAssessment: null, consecutiveScanFailures: 0 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writes and reads state atomically", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "livesite-state-test-"));
  try {
    const file = path.join(dir, "state.json");
    const data = {
      alerts: { "key-1": { assignedAt: "2026-09-02T22:00:00Z", attempt: 1 } },
      lastAssessment: { at: "2026-09-02T22:00:00Z", assessments: [] },
      consecutiveScanFailures: 0,
    };
    await writeJsonAtomic(file, data);
    const readBack = await readState(file);
    assert.deepEqual(readBack, data);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
