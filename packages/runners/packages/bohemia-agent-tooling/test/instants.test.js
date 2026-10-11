import test from "node:test";
import assert from "node:assert/strict";

import {
  parseInstant,
  tryParseInstant,
  minutesBetween,
  splitByCutoff,
  truncateToSecond,
  groupByInstantSecond,
  correlateToInstants,
  gapsInSeries,
} from "../src/instants.js";

test("a gap wider than the floor is reported and a narrower one is not", () => {
  const rows = [
    { at: "2026-09-01T00:00:00Z" },
    { at: "2026-09-01T00:01:00Z" },
    { at: "2026-09-01T00:06:00Z" },
    { at: "2026-09-01T00:07:00Z" },
  ];
  const result = gapsInSeries(rows, (row) => row.at, { minimumGapMinutes: 3 });
  assert.equal(result.gapCount, 1);
  assert.deepEqual(result.gaps[0], {
    from: "2026-09-01T00:01:00.000Z",
    to: "2026-09-01T00:06:00.000Z",
    minutes: 5,
  });
  assert.equal(result.totalMinutes, 5);
  assert.equal(result.widest.minutes, 5);
});

test("rows arriving out of order are sorted before the gaps are read off them", () => {
  const rows = [
    { at: "2026-09-01T00:06:00Z" },
    { at: "2026-09-01T00:00:00Z" },
    { at: "2026-09-01T00:01:00Z" },
  ];
  const result = gapsInSeries(rows, (row) => row.at, { minimumGapMinutes: 3 });
  assert.equal(result.gapCount, 1);
  assert.equal(result.first, "2026-09-01T00:00:00.000Z");
  assert.equal(result.last, "2026-09-01T00:06:00.000Z");
});

test("a row with no usable instant is counted apart and never closes a gap", () => {
  const rows = [
    { at: "2026-09-01T00:00:00Z" },
    { at: null },
    { at: "not a timestamp" },
    { at: "2026-09-01T00:06:00Z" },
  ];
  const result = gapsInSeries(rows, (row) => row.at, { minimumGapMinutes: 3 });
  assert.equal(result.undated, 2);
  assert.equal(result.dated, 2);
  assert.equal(result.gapCount, 1);
});

test("an offset free instant is read as UTC here too, so a gap cannot be invented by a zone", () => {
  const result = gapsInSeries(
    [{ at: "2026-09-01 00:00:00" }, { at: "2026-09-01T00:01:00Z" }],
    (row) => row.at,
    { minimumGapMinutes: 3 },
  );
  assert.equal(result.gapCount, 0);
});

test("a series with fewer than two dated rows has no gaps and no widest gap", () => {
  const result = gapsInSeries([{ at: "2026-09-01T00:00:00Z" }], (row) => row.at, {
    minimumGapMinutes: 3,
  });
  assert.equal(result.gapCount, 0);
  assert.equal(result.widest, null);
  assert.equal(result.totalMinutes, 0);
});

test("gapsInSeries refuses a reader, an array or a floor it cannot use", () => {
  assert.throws(() => gapsInSeries(null, (row) => row.at), /array/);
  assert.throws(() => gapsInSeries([], null), /reader/);
  assert.throws(() => gapsInSeries([], (row) => row.at, { minimumGapMinutes: 0 }), /positive/);
});

test("an offset bearing timestamp parses to the instant it names", () => {
  assert.equal(parseInstant("2026-09-01T22:39:16Z").toISOString(), "2026-09-01T22:39:16.000Z");
  assert.equal(parseInstant("2026-09-01T18:39:16-04:00").toISOString(), "2026-09-01T22:39:16.000Z");
});

test("a timestamp with no offset is read as utc rather than as local time", () => {
  assert.equal(parseInstant("2026-09-01T22:39:16").toISOString(), "2026-09-01T22:39:16.000Z");
  assert.equal(parseInstant("2026-09-01 22:39:16").toISOString(), "2026-09-01T22:39:16.000Z");
});

test("an unparsable instant throws rather than becoming a silent zero", () => {
  assert.throws(() => parseInstant("not a time"), /not a parsable timestamp/);
  assert.throws(() => parseInstant(""), /non empty string/);
  assert.equal(tryParseInstant("not a time"), null);
  assert.equal(tryParseInstant(null), null);
});

test("minutes between two instants ignores the host zone", () => {
  assert.equal(minutesBetween("2026-09-01T22:00:00Z", "2026-09-01T22:30:00Z"), 30);
  assert.equal(minutesBetween("2026-09-01T18:00:00-04:00", "2026-09-01T22:30:00Z"), 30);
});

test("a cohort split puts the cutoff instant itself in the after cohort", () => {
  const rows = [
    { at: "2026-09-01T22:39:15Z" },
    { at: "2026-09-01T22:39:16Z" },
    { at: "2026-09-01T22:39:17Z" },
  ];
  const split = splitByCutoff(rows, "2026-09-01T22:39:16Z", (row) => row.at);
  assert.equal(split.before.length, 1);
  assert.equal(split.after.length, 2);
  assert.equal(split.cutoff, "2026-09-01T22:39:16.000Z");
});

test("a row with no usable instant lands in neither cohort", () => {
  const rows = [{ at: null }, { at: "2026-09-01T23:00:00Z" }];
  const split = splitByCutoff(rows, "2026-09-01T22:39:16Z", (row) => row.at);
  assert.equal(split.undated.length, 1);
  assert.equal(split.before.length, 0);
  assert.equal(split.after.length, 1);
});

test("no cutoff means every dated row is one cohort", () => {
  const rows = [{ at: "2020-01-01T00:00:00Z" }, { at: "2026-09-01T23:00:00Z" }];
  const split = splitByCutoff(rows, null, (row) => row.at);
  assert.equal(split.after.length, 2);
  assert.equal(split.before.length, 0);
  assert.equal(split.cutoff, null);
});

test("an instant truncated to the second drops the millisecond noise between rows", () => {
  assert.equal(truncateToSecond("2026-09-01T23:05:52.418Z"), "2026-09-01T23:05:52.000Z");
  assert.equal(truncateToSecond("2026-09-01T23:05:52Z"), "2026-09-01T23:05:52.000Z");
});

test("rows recorded milliseconds apart group into one instant with a distinct count", () => {
  const rows = [
    { at: "2026-09-01T23:05:52.100Z", agent: "a" },
    { at: "2026-09-01T23:05:52.900Z", agent: "b" },
    { at: "2026-09-01T23:05:52.950Z", agent: "b" },
    { at: "2026-09-01T23:13:01.010Z", agent: "c" },
  ];
  const grouped = groupByInstantSecond(rows, (row) => row.at, { distinctBy: (row) => row.agent });
  assert.deepEqual(grouped.groups, [
    { instant: "2026-09-01T23:05:52.000Z", count: 3, distinctCount: 2, distinctValues: ["a", "b"] },
    { instant: "2026-09-01T23:13:01.000Z", count: 1, distinctCount: 1, distinctValues: ["c"] },
  ]);
  assert.equal(grouped.bucketSeconds, 1);
  assert.equal(grouped.undated.length, 0);
});

test("a row with no usable instant is reported rather than counted into a group", () => {
  const grouped = groupByInstantSecond([{ at: null }, { at: "2026-09-01T23:05:52Z" }], (row) => row.at);
  assert.equal(grouped.groups.length, 1);
  assert.equal(grouped.groups[0].distinctCount, undefined);
  assert.equal(grouped.undated.length, 1);
});

test("grouping is the same on a host whose local time is not utc", () => {
  const rows = [{ at: "2026-09-01T23:05:52.100Z" }, { at: "2026-09-01T23:05:52.900Z" }];
  const original = process.env.TZ;
  process.env.TZ = "UTC";
  const utc = JSON.stringify(groupByInstantSecond(rows, (row) => row.at).groups);
  for (const zone of ["Asia/Tokyo", "America/Los_Angeles"]) {
    process.env.TZ = zone;
    assert.equal(JSON.stringify(groupByInstantSecond(rows, (row) => row.at).groups), utc, zone);
  }
  if (original === undefined) delete process.env.TZ;
  else process.env.TZ = original;
});

test("a row is correlated to the nearest instant only when it falls inside the tolerance", () => {
  const rows = [
    { at: "2026-09-01T23:05:30Z" },
    { at: "2026-09-01T23:12:01Z" },
    { at: "2026-09-01T22:00:00Z" },
  ];
  const correlation = correlateToInstants(
    rows,
    (row) => row.at,
    ["2026-09-01T23:05:52Z", "2026-09-01T23:13:01Z"],
    { toleranceMinutes: 2 },
  );
  assert.equal(correlation.matched, 2);
  assert.equal(correlation.unmatched, 1);
  assert.equal(correlation.matches[0].nearest, "2026-09-01T23:05:52.000Z");
  assert.equal(correlation.matches[0].gapMinutes, 0.37);
  assert.equal(correlation.matches[2].matched, false);
});

test("a correlation with no instants and a row with no instant match nothing", () => {
  assert.equal(correlateToInstants([{ at: "2026-09-01T23:05:30Z" }], (row) => row.at, []).matched, 0);
  const none = correlateToInstants([{ at: null }], (row) => row.at, ["2026-09-01T23:05:52Z"]);
  assert.equal(none.matched, 0);
  assert.equal(none.matches[0].nearest, null);
});

test("a correlation refuses a negative tolerance and a missing reader", () => {
  assert.throws(() => correlateToInstants([], (row) => row.at, [], { toleranceMinutes: -1 }), /non negative/);
  assert.throws(() => correlateToInstants([], null, []), /instant reader/);
  assert.throws(() => groupByInstantSecond([], null), /instant reader/);
});
