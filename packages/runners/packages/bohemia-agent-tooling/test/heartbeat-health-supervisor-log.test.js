import test from "node:test";
import assert from "node:assert/strict";

import {
  parseSupervisorLog,
  summarizeSupervisorRecord,
  createSupervisorLogSource,
  SUPERVISOR_EVENTS,
} from "../tools/heartbeat-health/supervisor-log.js";

const RECORD = [
  "[paperclip] dev-watch: file watching disabled (PAPERCLIP_DEV_NO_WATCH=true)",
  '[18:50:27] DEBUG: skipping orphan reap for heartbeat run that is still producing output {"runId":"run-a","agentId":"agent-1","recentOutputAgeMs":595842,"processPid":31468,"processGroupId":31468}',
  '[18:50:32] DEBUG: skipping orphan reap for heartbeat run that is still producing output {"runId":"run-b","agentId":"agent-2","recentOutputAgeMs":593934,"processPid":47584,"processGroupId":47584}',
  '[18:50:38] WARN: reaped orphaned heartbeat runs {"reapedCount":2,"runIds":["run-c","run-d"]}',
  '[18:50:38] INFO: startup reap of orphaned heartbeat runs complete {"reaped":2,"runIds":["run-c","run-d"]}',
  '[18:50:40] WARN: terminalized orphaned running heartbeat run in stale-lock sweep {"runId":"run-b","authority":"process_gone","previousStatus":"running","terminalStatus":"interrupted","processGroupId":47584}',
  "[18:50:46] INFO: Server listening on 127.0.0.1:3400",
].join("\n");

test("the record is read at the date and offset the caller supplies, never guessed", () => {
  const parsed = parseSupervisorLog(RECORD, { date: "2026-09-01", utcOffsetMinutes: -420 });
  const skip = parsed.events.find((entry) => entry.event === SUPERVISOR_EVENTS.GUARD_SKIP);
  assert.equal(skip.instant, "2026-09-02T01:50:27.000Z");
  assert.equal(skip.runIds[0], "run-a");
  assert.equal(skip.payload.recentOutputAgeMs, 595842);
});

test("a record with no date or no offset is refused rather than read at the local zone", () => {
  assert.throws(() => parseSupervisorLog(RECORD, { utcOffsetMinutes: 0 }), /date/);
  assert.throws(() => parseSupervisorLog(RECORD, { date: "2026-09-01" }), /offset/);
  assert.throws(() => parseSupervisorLog(RECORD, { date: "sept 1", utcOffsetMinutes: 0 }), /date/);
});

test("a record that rolls past midnight advances the day rather than folding back", () => {
  const rolling = [
    '[23:59:59] WARN: reaped orphaned heartbeat runs {"reapedCount":1,"runIds":["run-late"]}',
    '[00:00:04] WARN: reaped orphaned heartbeat runs {"reapedCount":1,"runIds":["run-early"]}',
  ].join("\n");
  const parsed = parseSupervisorLog(rolling, { date: "2026-09-01", utcOffsetMinutes: 0 });
  assert.equal(parsed.events[0].instant, "2026-09-01T23:59:59.000Z");
  assert.equal(parsed.events[1].instant, "2026-09-02T00:00:04.000Z");
});

test("lines the record carries that name no run decision are ignored", () => {
  const parsed = parseSupervisorLog(RECORD, { date: "2026-09-01", utcOffsetMinutes: -420 });
  assert.equal(parsed.events.length, 6);
  assert.ok(parsed.events.every((entry) => entry.event !== null));
});

test("a run the guard skipped and another path terminalized anyway is counted as a guard hole", () => {
  const summary = summarizeSupervisorRecord(
    parseSupervisorLog(RECORD, { date: "2026-09-01", utcOffsetMinutes: -420 }),
  );
  assert.equal(summary.guardSkippedRuns, 2);
  assert.equal(summary.reapedRuns, 2);
  assert.equal(summary.staleLockTerminalizedRuns, 1);
  assert.equal(summary.guardHoleRuns, 1);

  const [hole] = summary.guardHoles;
  assert.equal(hole.runId, "run-b");
  assert.equal(hole.terminalizedBy, "stale_lock_sweep");
  assert.equal(hole.authority, "process_gone");
  assert.equal(hole.terminalStatus, "interrupted");
  assert.equal(hole.secondsAfterSkip, 8);
  assert.equal(hole.processPid, 47584);
});

test("a run the guard skipped and nothing terminalized is not a hole", () => {
  const summary = summarizeSupervisorRecord(
    parseSupervisorLog(RECORD, { date: "2026-09-01", utcOffsetMinutes: -420 }),
  );
  assert.ok(!summary.guardHoles.some((hole) => hole.runId === "run-a"));
});

test("a termination recorded before the skip is not read as a hole the skip opened", () => {
  const outOfOrder = [
    '[18:50:40] WARN: terminalized orphaned running heartbeat run in stale-lock sweep {"runId":"run-x","authority":"process_gone"}',
    '[18:50:50] DEBUG: skipping orphan reap for heartbeat run that is still producing output {"runId":"run-x","recentOutputAgeMs":1000}',
  ].join("\n");
  const summary = summarizeSupervisorRecord(
    parseSupervisorLog(outOfOrder, { date: "2026-09-01", utcOffsetMinutes: 0 }),
  );
  assert.equal(summary.guardHoleRuns, 0);
});

test("the startup instants are reported once each and sorted", () => {
  const summary = summarizeSupervisorRecord(
    parseSupervisorLog(RECORD, { date: "2026-09-01", utcOffsetMinutes: -420 }),
  );
  assert.deepEqual(summary.startupInstants, [
    "2026-09-02T01:50:38.000Z",
    "2026-09-02T01:50:46.000Z",
  ]);
  assert.equal(summary.startups, 2);
});

test("the source reads the record through the supplied reader and nothing else", async () => {
  const seen = [];
  const source = createSupervisorLogSource({
    readFile: async (path, encoding) => {
      seen.push({ path, encoding });
      return RECORD;
    },
  });
  const summary = await source.readRecord({
    path: "record.log",
    date: "2026-09-01",
    utcOffsetMinutes: -420,
  });
  assert.deepEqual(seen, [{ path: "record.log", encoding: "utf8" }]);
  assert.equal(summary.guardHoleRuns, 1);
});

test("a record coloured for a terminal parses to the same events as a plain one", () => {
  const coloured = [
    "[18:50:38] \u001b[33mWARN\u001b[39m: \u001b[36mreaped orphaned heartbeat runs\u001b[39m \u001b[90m{\"reapedCount\":2,\"runIds\":[\"run-c\",\"run-d\"]}\u001b[39m",
  ].join("\n");
  const parsed = parseSupervisorLog(coloured, { date: "2026-09-01", utcOffsetMinutes: -420 });
  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.events[0].event, SUPERVISOR_EVENTS.REAP);
  assert.equal(parsed.events[0].instant, "2026-09-02T01:50:38.000Z");
  assert.deepEqual(parsed.events[0].runIds, ["run-c", "run-d"]);
  assert.equal(parsed.events[0].payload.reapedCount, 2);
});

test("a source with no reader is refused", () => {
  assert.throws(() => createSupervisorLogSource({}), /readFile/);
});

test("a hole landing on the far edge of the window is counted as the guard expiring", () => {
  const summary = summarizeSupervisorRecord(
    parseSupervisorLog(RECORD, { date: "2026-09-01", utcOffsetMinutes: -420 }),
  );
  const [hole] = summary.guardHoles;
  // 593934 ms of quiet at the skip, terminalized 8 seconds later, so the run died 10.03 minutes
  // after its last output. Both numbers come off the record and neither reads a clock.
  assert.equal(hole.outputAgeAtTerminalizationMs, 601934);
  assert.equal(hole.atGuardExpiry, true);
  assert.equal(summary.guardExpiryKills, 1);
  assert.equal(summary.guardHolesWithOutputAge, 1);
});

test("a hole well inside the window is a hole but not the guard expiring", () => {
  const early = [
    '[18:50:27] DEBUG: skipping orphan reap for heartbeat run that is still producing output {"runId":"run-a","recentOutputAgeMs":60000,"processPid":11}',
    '[18:50:37] WARN: terminalized orphaned running heartbeat run in stale-lock sweep {"runId":"run-a","authority":"process_gone"}',
  ].join("\n");
  const summary = summarizeSupervisorRecord(
    parseSupervisorLog(early, { date: "2026-09-01", utcOffsetMinutes: -420 }),
  );
  assert.equal(summary.guardHoleRuns, 1);
  assert.equal(summary.guardHoles[0].outputAgeAtTerminalizationMs, 70000);
  assert.equal(summary.guardHoles[0].atGuardExpiry, false);
  assert.equal(summary.guardExpiryKills, 0);
});

test("the window and the tolerance are the caller's and are reported back", () => {
  const parsed = parseSupervisorLog(RECORD, { date: "2026-09-01", utcOffsetMinutes: -420 });
  const wider = summarizeSupervisorRecord(parsed, { outputRecencyGuardMs: 60 * 1000 });
  assert.equal(wider.outputRecencyGuardMs, 60 * 1000);
  assert.equal(wider.guardExpiryKills, 0);

  const tight = summarizeSupervisorRecord(parsed, { guardExpiryToleranceMs: 100 });
  assert.equal(tight.guardExpiryToleranceMs, 100);
  assert.equal(tight.guardExpiryKills, 0);

  assert.throws(() => summarizeSupervisorRecord(parsed, { outputRecencyGuardMs: 0 }), /guard/);
  assert.throws(() => summarizeSupervisorRecord(parsed, { guardExpiryToleranceMs: -1 }), /tolerance/);
});

test("a hole whose skip carried no output age is neither counted nor denominated", () => {
  const ageless = [
    '[18:50:27] DEBUG: skipping orphan reap for heartbeat run that is still producing output {"runId":"run-a","processPid":11}',
    '[18:50:37] WARN: terminalized orphaned running heartbeat run in stale-lock sweep {"runId":"run-a","authority":"process_gone"}',
  ].join("\n");
  const summary = summarizeSupervisorRecord(
    parseSupervisorLog(ageless, { date: "2026-09-01", utcOffsetMinutes: -420 }),
  );
  assert.equal(summary.guardHoleRuns, 1);
  assert.equal(summary.guardHoles[0].outputAgeAtTerminalizationMs, null);
  assert.equal(summary.guardHoles[0].atGuardExpiry, false);
  assert.equal(summary.guardExpiryKills, 0);
  assert.equal(summary.guardHolesWithOutputAge, 0);
});
