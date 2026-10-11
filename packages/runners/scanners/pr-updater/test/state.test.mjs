/**
 * State survival across passes.
 *
 * This is the regression test for a live defect: the reader borrowed from the monitor kept only
 * its own three keys, so the record of what had been sent vanished every cycle. The same pull
 * request was dispatched on every pass and every failing build was requeued forever.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readState, writeJsonAtomic } from "../lib/state.mjs";

function scratch() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "updater-state-")), "state.json");
}

test("what was sent and what was requeued both survive a round trip", async () => {
  const file = scratch();
  const written = {
    pullRequests: { 5634985: { fingerprint: "review:2026-03-01T11:00:00.000Z", lastSentAt: "2026-03-01T12:00:00.000Z" } },
    builds: { 5633465: { commit: "abc", ids: [54057110] } },
  };
  await writeJsonAtomic(file, written);
  const read = await readState(file);
  assert.deepEqual(read.pullRequests, written.pullRequests, "the send record must outlive the pass that made it");
  assert.deepEqual(read.builds, written.builds, "a requeue is remembered, so a build is retried once");
});

test("a missing file starts empty rather than throwing", async () => {
  const state = await readState(path.join(os.tmpdir(), "nope", "state.json"));
  assert.deepEqual(state, { pullRequests: {}, builds: {} });
});

test("an unreadable file starts over rather than stopping the runner", async () => {
  const file = scratch();
  fs.writeFileSync(file, "{ this is not json");
  assert.deepEqual(await readState(file), { pullRequests: {}, builds: {} });
});

test("unexpected shapes are replaced rather than trusted", async () => {
  const file = scratch();
  fs.writeFileSync(file, JSON.stringify({ pullRequests: ["nope"], builds: 7 }));
  assert.deepEqual(await readState(file), { pullRequests: {}, builds: {} });
});
