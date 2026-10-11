import test from "node:test";
import assert from "node:assert/strict";

import {
  anchorSupervisorRecord,
  mergeSupervisorRecords,
  parseAnchoredSupervisorLog,
  readSupervisorClockEvents,
  summarizeSupervisorRecord,
} from "../tools/heartbeat-health/supervisor-log.js";
import {
  discoverSupervisorRecords,
  isSupervisorRecordCandidate,
  readDiscoveredSupervisorRecord,
  terminalInstantsOf,
} from "../tools/heartbeat-health/supervisor-discovery.js";

/*
 * The record the supervisor writes carries a time of day and nothing else. These fixtures are that
 * shape exactly, and every instant a test asserts is derived from the rows, never supplied.
 */
const PACIFIC_RECORD = [
  "[16:00:52] WARN: skipping orphan reap for heartbeat run that is still producing output {\"runId\":\"b1\",\"recentOutputAgeMs\":300000,\"processPid\":4242}",
  "[16:05:52] WARN: terminalized orphaned running heartbeat run in stale-lock sweep {\"runId\":\"b1\",\"authority\":\"process_gone\",\"terminalStatus\":\"failed\"}",
  "[16:05:53] INFO: Server listening on 127.0.0.1:3400",
].join("\n");

const SECOND_RECORD = [
  "[23:58:00] WARN: skipping orphan reap for heartbeat run that is still producing output {\"runId\":\"b2\",\"recentOutputAgeMs\":60000,\"processPid\":77}",
  "[00:02:00] WARN: reaped orphaned heartbeat runs {\"reapedCount\":1,\"runIds\":[\"b2\"]}",
  "[00:02:01] INFO: Server listening on 127.0.0.1:3400",
].join("\n");

const runs = [
  { id: "b1", finishedAt: "2026-09-01T23:05:52.418Z", status: "failed" },
  { id: "b2", finishedAt: "2026-09-02T07:02:00.100Z", status: "failed" },
  { id: "b3", status: "running" },
];

test("a record is placed on the calendar from the rows it names, with nothing supplied", () => {
  const anchor = anchorSupervisorRecord(readSupervisorClockEvents(PACIFIC_RECORD), {
    terminalInstants: terminalInstantsOf(runs),
  });
  assert.equal(anchor.placed, true);
  assert.equal(anchor.date, "2026-09-01");
  assert.equal(anchor.utcOffsetMinutes, -420);
  assert.equal(anchor.anchors, 1);
});

test("the placement does not move with the host's own zone", () => {
  const original = process.env.TZ;
  const placements = ["UTC", "Asia/Tokyo", "America/Los_Angeles"].map((zone) => {
    process.env.TZ = zone;
    return anchorSupervisorRecord(readSupervisorClockEvents(PACIFIC_RECORD), {
      terminalInstants: terminalInstantsOf(runs),
    });
  });
  process.env.TZ = original;
  assert.deepEqual(placements[1], placements[0]);
  assert.deepEqual(placements[2], placements[0]);
});

test("a record that crosses midnight keeps the second day on the second day", () => {
  const read = parseAnchoredSupervisorLog(SECOND_RECORD, {
    terminalInstants: terminalInstantsOf(runs),
  });
  assert.equal(read.anchor.placed, true);
  assert.equal(read.anchor.date, "2026-09-01");
  assert.equal(read.parsed.events[0].instant, "2026-09-02T06:58:00.000Z");
  assert.equal(read.parsed.events[1].instant, "2026-09-02T07:02:00.000Z");
});

test("a record that names no run the rows record a finish for is not placed, and says why", () => {
  const read = parseAnchoredSupervisorLog(PACIFIC_RECORD, { terminalInstants: new Map() });
  assert.equal(read.anchor.placed, false);
  assert.equal(read.parsed, null);
  assert.match(read.anchor.reason, /terminalizes a run the rows record a finish for/);
  assert.deepEqual(read.namedRunIds, ["b1"]);
});

test("lines that disagree on the day leave the record unplaced rather than placed anywhere", () => {
  const disagreeing = [
    "[16:05:52] WARN: reaped orphaned heartbeat runs {\"runIds\":[\"b1\"]}",
    "[16:05:53] WARN: reaped orphaned heartbeat runs {\"runIds\":[\"b2\"]}",
  ].join("\n");
  const anchor = anchorSupervisorRecord(readSupervisorClockEvents(disagreeing), {
    terminalInstants: terminalInstantsOf(runs),
  });
  assert.equal(anchor.placed, false);
  assert.match(anchor.reason, /disagree on the day/);
});

test("every startup across every record is read, not one file and one day", () => {
  const first = parseAnchoredSupervisorLog(PACIFIC_RECORD, {
    terminalInstants: terminalInstantsOf(runs),
  }).parsed;
  const second = parseAnchoredSupervisorLog(SECOND_RECORD, {
    terminalInstants: terminalInstantsOf(runs),
  }).parsed;
  const summary = summarizeSupervisorRecord(mergeSupervisorRecords([first, second]));
  assert.equal(summary.startups, 2);
  assert.equal(summary.guardSkippedRuns, 2);
  assert.equal(summary.guardHoleRuns, 2);
  assert.deepEqual(summary.dates, ["2026-09-01"]);
});

test("a guard hole that records no authority is its own number", () => {
  const parsed = parseAnchoredSupervisorLog(SECOND_RECORD, {
    terminalInstants: terminalInstantsOf(runs),
  }).parsed;
  const summary = summarizeSupervisorRecord(parsed);
  assert.equal(summary.guardHoleRuns, 1);
  assert.equal(summary.guardHolesWithoutRecordedAuthority, 1);
  assert.deepEqual(summary.guardHolesByTerminatingPath, [
    { key: "orphan_reap", count: 1, withoutAuthority: 1 },
  ]);
  const withAuthority = summarizeSupervisorRecord(
    parseAnchoredSupervisorLog(PACIFIC_RECORD, { terminalInstants: terminalInstantsOf(runs) })
      .parsed,
  );
  assert.equal(withAuthority.guardHoleRuns, 1);
  assert.equal(withAuthority.guardHolesWithoutRecordedAuthority, 0);
});

function directoryOf(files) {
  return {
    directory: "records",
    listFiles: async () => Object.keys(files),
    readFile: async (path) => {
      const name = path.split(/[\\/]/).pop();
      if (!(name in files)) throw new Error(`no such record ${path}`);
      return files[name];
    },
    runs,
  };
}

test("only the files that can hold a record are candidates", () => {
  assert.equal(isSupervisorRecordCandidate("dev-3400.log"), true);
  assert.equal(isSupervisorRecordCandidate("dev-3400.log.err"), false);
  assert.equal(isSupervisorRecordCandidate("dev-3400.err.log"), false);
  assert.equal(isSupervisorRecordCandidate("adapter-plugins.json"), false);
});

test("discovery reads every record in the directory and names what it did with each", async () => {
  const discovered = await discoverSupervisorRecords(
    directoryOf({
      "one.log": PACIFIC_RECORD,
      "two.log": SECOND_RECORD,
      "unrelated.log": "[09:00:00] INFO: nothing this reader knows about\n",
    }),
  );
  assert.equal(discovered.candidates, 3);
  assert.equal(discovered.placed.length, 2);
  assert.equal(discovered.gaps.length, 0);
  assert.deepEqual(
    discovered.excluded.map((record) => record.reason),
    ["carries no supervisor lines"],
  );
});

test("a record that names cohort runs and cannot be placed is refused, not passed over", async () => {
  const unplaceable = [
    "[16:00:52] WARN: skipping orphan reap for heartbeat run that is still producing output {\"runId\":\"b3\",\"recentOutputAgeMs\":1000,\"processPid\":9}",
  ].join("\n");
  const discovered = await discoverSupervisorRecords(
    directoryOf({ "one.log": PACIFIC_RECORD, "gap.log": unplaceable }),
  );
  assert.equal(discovered.gaps.length, 1);
  await assert.rejects(
    readDiscoveredSupervisorRecord(directoryOf({ "one.log": PACIFIC_RECORD, "gap.log": unplaceable })),
    /cannot place a record that names runs in this cohort/,
  );
});

test("a record naming no run of this cohort is left out with that reason rather than refused", async () => {
  const elsewhere = [
    "[16:00:52] WARN: skipping orphan reap for heartbeat run that is still producing output {\"runId\":\"other\",\"recentOutputAgeMs\":1000,\"processPid\":9}",
  ].join("\n");
  const reading = await readDiscoveredSupervisorRecord(
    directoryOf({ "one.log": PACIFIC_RECORD, "elsewhere.log": elsewhere }),
  );
  assert.equal(reading.discovery.records.length, 1);
  assert.match(reading.discovery.excluded[0].reason, /names no run in this cohort/);
});

test("a directory with no placeable record fails the reading rather than scoring zero of zero", async () => {
  await assert.rejects(
    readDiscoveredSupervisorRecord(directoryOf({ "unrelated.log": "[09:00:00] INFO: quiet\n" })),
    /found no placeable record/,
  );
});

test("the reading says which records it was taken from and how each was placed", async () => {
  const reading = await readDiscoveredSupervisorRecord(
    directoryOf({ "one.log": PACIFIC_RECORD, "two.log": SECOND_RECORD }),
  );
  assert.equal(reading.guardSkippedRuns, 2);
  assert.equal(reading.guardHoleRuns, 2);
  assert.equal(reading.guardExpiryKills, 1);
  assert.equal(reading.discovery.candidates, 2);
  assert.deepEqual(
    reading.discovery.records.map((record) => [record.date, record.utcOffsetMinutes, record.anchors]),
    [
      ["2026-09-01", -420, 1],
      ["2026-09-01", -420, 1],
    ],
  );
});
