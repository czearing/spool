import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyProcessIdentity,
  verifyProcessIdentity,
  indexProcessTable,
  isSameProcess,
  isProvenFinished,
  IDENTITY_SAME,
  IDENTITY_REUSED,
  IDENTITY_GONE,
  IDENTITY_UNVERIFIABLE,
} from "../src/process-identity.js";

const recorded = { pid: 4242, startedAt: "2026-09-01T23:00:00Z" };

test("a process holding the recorded id since the recorded instant is the recorded process", () => {
  const verdict = classifyProcessIdentity(recorded, {
    pid: 4242,
    startedAt: "2026-09-01T22:59:58Z",
  });
  assert.equal(verdict.verdict, IDENTITY_SAME);
  assert.equal(isSameProcess(verdict.verdict), true);
  assert.equal(isProvenFinished(verdict.verdict), false);
});

test("an id the operating system handed to a later process is a reuse and not a live run", () => {
  const verdict = classifyProcessIdentity(recorded, {
    pid: 4242,
    startedAt: "2026-09-01T23:04:00Z",
  });
  assert.equal(verdict.verdict, IDENTITY_REUSED);
  assert.equal(verdict.driftSeconds, 240);
  assert.equal(isProvenFinished(verdict.verdict), true);
});

test("a marker the observed process does not carry is a reuse even when the start times are missing", () => {
  const verdict = classifyProcessIdentity(
    { pid: 4242, marker: "run-abc" },
    { pid: 4242, commandLine: "node other.js" },
  );
  assert.equal(verdict.verdict, IDENTITY_REUSED);
});

test("no process on the recorded id proves the recorded process is finished", () => {
  const verdict = classifyProcessIdentity(recorded, null);
  assert.equal(verdict.verdict, IDENTITY_GONE);
  assert.equal(isProvenFinished(verdict.verdict), true);
});

test("a probe that could not answer is unverifiable and never terminalizes a run", () => {
  const noPid = classifyProcessIdentity({ startedAt: "2026-09-01T23:00:00Z" }, null);
  assert.equal(noPid.verdict, IDENTITY_UNVERIFIABLE);

  const noStart = classifyProcessIdentity({ pid: 4242 }, { pid: 4242 });
  assert.equal(noStart.verdict, IDENTITY_UNVERIFIABLE);

  const wrongRow = classifyProcessIdentity(recorded, { pid: 99, startedAt: "2026-09-01T23:00:00Z" });
  assert.equal(wrongRow.verdict, IDENTITY_UNVERIFIABLE);

  for (const verdict of [noPid, noStart, wrongRow]) {
    assert.equal(isSameProcess(verdict.verdict), false);
    assert.equal(isProvenFinished(verdict.verdict), false);
  }
});

test("the clock skew between a recorded start and an observed start does not read as a reuse", () => {
  const verdict = classifyProcessIdentity(recorded, {
    pid: 4242,
    startedAt: "2026-09-01T23:00:03Z",
  });
  assert.equal(verdict.verdict, IDENTITY_SAME);
  assert.equal(verdict.driftSeconds, 3);

  const tightened = classifyProcessIdentity(
    recorded,
    { pid: 4242, startedAt: "2026-09-01T23:00:03Z" },
    { toleranceSeconds: 1 },
  );
  assert.equal(tightened.verdict, IDENTITY_REUSED);
});

test("a process table is indexed by id so a probe is a lookup rather than a scan", () => {
  const index = indexProcessTable([
    { pid: "4242", startedAt: "2026-09-01T23:00:00Z" },
    { pid: 0, startedAt: "2026-09-01T23:00:00Z" },
    { startedAt: "2026-09-01T23:00:00Z" },
  ]);
  assert.equal(index.size, 1);
  assert.equal(index.get(4242).pid, 4242);
});

test("a probe reports the running and finished verdicts a supervisor acts on", () => {
  const table = [{ pid: 4242, startedAt: "2026-09-01T23:00:00Z" }];

  const alive = verifyProcessIdentity(recorded, table);
  assert.equal(alive.running, true);
  assert.equal(alive.finished, false);
  assert.equal(alive.pid, 4242);

  const gone = verifyProcessIdentity({ pid: 777, startedAt: "2026-09-01T23:00:00Z" }, table);
  assert.equal(gone.running, false);
  assert.equal(gone.finished, true);
  assert.equal(gone.verdict, IDENTITY_GONE);

  const unverifiable = verifyProcessIdentity({ startedAt: "2026-09-01T23:00:00Z" }, table);
  assert.equal(unverifiable.running, false);
  assert.equal(unverifiable.finished, false);
});
