import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readState, writeJsonAtomic } from "../lib/state.mjs";

test("replaces an existing status file", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pr-reviewer-state-"));
  const file = path.join(directory, "status.json");
  try {
    await writeJsonAtomic(file, { version: 1 });
    await writeJsonAtomic(file, { version: 2 });
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { version: 2 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("migrates old state without replaying existing old assignments", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pr-reviewer-state-migration-"));
  const file = path.join(directory, "state.json");
  try {
    await writeJsonAtomic(file, { active: ["existing"] });
    assert.deepEqual(await readState(file), {
      active: ["existing"],
      reviewerAssignments: null,
      ageExemptReviewerAssignments: [],
      revisionObservations: {},
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("revision stability observations survive runner restarts", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pr-reviewer-observations-"));
  const file = path.join(directory, "state.json");
  try {
    const revisionObservations = { "1": { sourceCommit: "abc", firstSeenAt: 1_000, lastSeenAt: 61_000 } };
    await writeJsonAtomic(file, { revisionObservations });
    assert.deepEqual((await readState(file)).revisionObservations, revisionObservations);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
