import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { parseArgs, renderTable } from "../tools/heartbeat-health/cli.js";
import { computeHealth } from "../tools/heartbeat-health/health.js";

const run = promisify(execFile);
const CLI = fileURLToPath(new URL("../tools/heartbeat-health/cli.js", import.meta.url));

const rows = [
  { startedAt: "2026-09-01T21:00:00Z", finishedAt: "2026-09-01T21:10:00Z", status: "succeeded" },
  {
    startedAt: "2026-09-01T21:30:00Z",
    lastOutputAt: "2026-09-01T21:45:00Z",
    status: "failed",
    error: "Process lost",
  },
  { startedAt: "2026-09-01T23:00:00Z", finishedAt: "2026-09-01T23:20:00Z", status: "succeeded" },
  {
    id: "b1",
    agentId: "agent-one",
    startedAt: "2026-09-01T23:00:00Z",
    finishedAt: "2026-09-01T23:05:52.418Z",
    lastOutputAt: "2026-09-01T23:05:33.218Z",
    status: "failed",
    errorCode: "orphaned_running_run",
    error: "run terminalized by recovery backstop: process and sandbox gone",
  },
];

/*
 * The supervisor's own record, in the shape the supervisor writes it: a time of day and nothing
 * else. The collector places it on the calendar from the rows above, so no date and no offset are
 * supplied here either, and the two clauses it scores are scored by the default command.
 */
const SUPERVISOR_RECORD = [
  '[16:00:52] WARN: skipping orphan reap for heartbeat run that is still producing output {"runId":"b1","recentOutputAgeMs":300000,"processPid":4242}',
  '[16:05:52] WARN: terminalized orphaned running heartbeat run in stale-lock sweep {"runId":"b1","authority":"process_gone","terminalStatus":"failed"}',
  "[16:05:53] INFO: Server listening on 127.0.0.1:3400",
].join("\n");

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "heartbeat-health-"));
  const file = path.join(dir, "runs.json");
  await writeFile(file, JSON.stringify({ runs: rows }), "utf8");
  await mkdir(path.join(dir, "records"), { recursive: true });
  await writeFile(path.join(dir, "records", "dev.log"), `${SUPERVISOR_RECORD}\n`, "utf8");
  return file;
}

/** Where the record fixture sits, alongside the rows it is placed against. */
function recordsOf(file) {
  return path.join(path.dirname(file), "records");
}

test("the arguments the collector accepts are the cutoff, the limit, the agent and the input", () => {
  const options = parseArgs(["--since", "2026-09-01T22:39:16Z", "--limit", "60", "--agent", "a"]);
  assert.equal(options.since, "2026-09-01T22:39:16Z");
  assert.equal(options.limit, 60);
  assert.equal(options.agentId, "a");
  assert.equal(options.issues, true);
  assert.equal(options.snapshot, null);
  assert.equal(parseArgs(["--snapshot", "rows.json"]).snapshot, "rows.json");
  assert.equal(parseArgs(["--no-issues"]).issues, false);
  assert.equal(parseArgs([]).limit, 500);
  assert.equal(parseArgs([]).supervisor, true);
  assert.equal(parseArgs([]).supervisorLogDirectory, null);
  assert.equal(parseArgs(["--no-supervisor"]).supervisor, false);
  assert.equal(parseArgs(["--supervisor-log-dir", "records"]).supervisorLogDirectory, "records");
  assert.throws(() => parseArgs(["--since"]), /needs a value/);
  assert.throws(() => parseArgs(["--limit", "zero"]), /positive number/);
  assert.throws(() => parseArgs(["--snapshot"]), /needs a value/);
  assert.throws(() => parseArgs(["--nope"]), /unknown option/);
});

test("a snapshot freezes the rows a reading was taken from and rescores to the same numbers", async () => {
  const file = await fixture();
  const snapshot = path.join(path.dirname(file), "snapshot.json");
  const args = [
    "--input",
    file,
    "--since",
    "2026-09-01T22:39:16Z",
    "--supervisor-log-dir",
    recordsOf(file),
    "--quiet",
  ];
  const reading = await run(process.execPath, [CLI, ...args, "--snapshot", snapshot]);
  const rescored = await run(process.execPath, [
    CLI,
    "--input",
    snapshot,
    "--since",
    "2026-09-01T22:39:16Z",
    "--supervisor-log-dir",
    recordsOf(file),
    "--quiet",
  ]);
  assert.equal(rescored.stdout, reading.stdout);
  assert.deepEqual(JSON.parse(await readFile(snapshot, "utf8")).runs, rows);
});

test("a snapshot keeps the cohort an earlier reading was scored on when the source moves", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "heartbeat-health-"));
  const frozen = path.join(dir, "frozen.json");
  const mutated = path.join(dir, "mutated.json");
  const stillRunning = {
    id: "r1",
    agentId: "agent-two",
    startedAt: "2026-09-01T23:40:00Z",
    lastOutputAt: "2026-09-01T23:41:00Z",
    status: "running",
  };
  await writeFile(frozen, JSON.stringify({ runs: [...rows, stillRunning] }), "utf8");
  await writeFile(
    mutated,
    JSON.stringify({
      runs: [
        ...rows,
        {
          ...stillRunning,
          status: "failed",
          finishedAt: "2026-09-01T23:56:00Z",
          error: "Process lost",
        },
      ],
    }),
    "utf8",
  );
  const read = async (input) => {
    const args = [
      CLI,
      "--input",
      input,
      "--since",
      "2026-09-01T22:39:16Z",
      "--no-supervisor",
      "--quiet",
    ];
    return JSON.parse((await run(process.execPath, args)).stdout);
  };
  assert.equal((await read(frozen)).after.processLostRuns, 0);
  assert.equal((await read(mutated)).after.processLostRuns, 1);
  assert.equal((await read(frozen)).before.processLostRuns, 1);
});

test("the table names every field a reader is asked to trust", () => {
  const table = renderTable(computeHealth(rows, { since: "2026-09-01T22:39:16Z" }));
  assert.match(table, /before/);
  assert.match(table, /after/);
  assert.match(table, /process lost/);
  assert.match(table, /succeeded/);
  assert.match(table, /finished minutes/);
  assert.match(table, /error signatures/);
  assert.match(table, /output recency guard/);
  assert.match(table, /backstop: 1 runs, quiet gap 0\.32 to 0\.32 minutes/);
  assert.match(table, /2026-09-01T23:05:52\.000Z {2}1 runs, 1 agents/);
  assert.match(table, /blocked issues: not read/);
  assert.match(table, /clauses:/);
});

test("the table names the six per run fields a clause is scored on", () => {
  const table = renderTable(computeHealth(rows, { since: "2026-09-01T22:39:16Z" }));
  assert.match(table, /silence instants of 60 seconds on last output/);
  assert.match(table, /carry an exit code/);
  assert.match(table, /carry a signal/);
  assert.match(table, /productive lifetime/);
  assert.match(table, /detection latency/);
  assert.match(table, /retries: /);
  assert.match(table, /per agent loss: /);
});

test("an empty cohort renders the retry line with no dangling separator", () => {
  const table = renderTable(computeHealth(rows, { since: "2026-09-01T22:39:16Z" }));
  const line = table.split("\n").find((entry) => entry.startsWith("before retries:"));
  assert.ok(line, "the before cohort must still render a retry line");
  assert.doesNotMatch(line, /, ,/);
  assert.doesNotMatch(line, /, $/);
});

test("the table reports the chain numbers the retry policy is scored on", () => {
  const table = renderTable(computeHealth(rows, { since: "2026-09-01T22:39:16Z" }));
  const line = table.split("\n").find((entry) => entry.startsWith("after chains:"));
  assert.ok(line, "the chain line must name the cohort it belongs to");
  assert.match(line, /wake chains over/);
  assert.match(line, /settled/);
  assert.match(line, /awaiting a scheduled retry/);
  assert.match(table, /settled chains abandoned/);
  assert.match(table, /carry no recorded reason/);
  assert.match(table, /attempts per chain/);
  assert.match(table, /settled wake chains abandoned with no further attempt/);
});

test("the table reports the board clause when the blocked issues were read", () => {
  const table = renderTable(
    computeHealth(rows, {
      since: "2026-09-01T22:39:16Z",
      issues: [
        {
          id: "1",
          identifier: "OFF-60",
          status: "blocked",
          blockedTransitionAt: "2026-09-01T23:13:33Z",
          blockedBy: [],
        },
      ],
    }),
  );
  assert.match(table, /blocked issues: 1 of 1 in window carry no wake path, 1 of those carry no blocker/);
  assert.match(
    table,
    /blocked chains: 0 of 1 blocked issues are chain terminals with no wake path, stranding 0 dependents/,
  );
  assert.match(table, /OFF-60 {2}2026-09-01T23:13:33Z/);
});

test("the json record goes to stdout and the table goes to stderr", async () => {
  const file = await fixture();
  const { stdout, stderr } = await run(process.execPath, [
    CLI,
    "--input",
    file,
    "--supervisor-log-dir",
    recordsOf(file),
  ]);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.metric, "heartbeat run health and per run liveness");
  assert.equal(parsed.window.startedRuns, 4);
  assert.equal(parsed.window.liveness.classes.backstop.runs, 1);
  assert.equal(parsed.blocked, null);
  assert.match(stderr, /process lost/);
});

test("the default reading places the supervisor record itself and scores both guard clauses", async () => {
  const file = await fixture();
  const { stdout, stderr } = await run(process.execPath, [
    CLI,
    "--input",
    file,
    "--supervisor-log-dir",
    recordsOf(file),
  ]);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.supervisor.discovery.records[0].date, "2026-09-01");
  assert.equal(parsed.supervisor.discovery.records[0].utcOffsetMinutes, -420);
  const holes = parsed.clauses["runs the output recency guard skipped and another path terminalized anyway"];
  assert.equal(holes.pass, false);
  assert.equal(holes.number, 1);
  assert.equal(holes.of, 1);
  assert.equal(holes.withoutRecordedAuthority, 0);
  assert.equal(
    parsed.clauses["guard skipped runs terminalized at the instant the guard expired"].pass,
    false,
  );
  assert.match(stderr, /supervisor record discovery: 1 of 1 candidate files/);
  assert.match(stderr, /guard holes by terminating path/);
});

test("refusing the record leaves the clauses unscored and says the record was not read", async () => {
  const file = await fixture();
  const { stdout, stderr } = await run(process.execPath, [CLI, "--input", file, "--no-supervisor"]);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.supervisor, null);
  assert.equal(
    parsed.clauses["runs the output recency guard skipped and another path terminalized anyway"].pass,
    null,
  );
  assert.match(stderr, /supervisor record: not read/);
});

test("a directory with no placeable record fails the command rather than passing the clauses over", async () => {
  const file = await fixture();
  const empty = path.join(path.dirname(file), "empty-records");
  await mkdir(empty, { recursive: true });
  const result = await run(process.execPath, [
    CLI,
    "--input",
    file,
    "--supervisor-log-dir",
    empty,
    "--quiet",
  ]).catch((error) => error);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /found no placeable record/);
});

test("a saved input file reports the board clause as not scored rather than as passing", async () => {
  const file = await fixture();
  const { stdout } = await run(process.execPath, [
    CLI,
    "--input",
    file,
    "--supervisor-log-dir",
    recordsOf(file),
    "--quiet",
  ]);
  assert.equal(JSON.parse(stdout).clauses["issues blocked with no blocker"].pass, null);
});

test("two runs against unchanged history return byte identical stdout", async () => {
  const file = await fixture();
  const args = [
    CLI,
    "--input",
    file,
    "--since",
    "2026-09-01T22:39:16Z",
    "--supervisor-log-dir",
    recordsOf(file),
    "--quiet",
  ];
  const first = await run(process.execPath, args);
  const second = await run(process.execPath, args);
  assert.equal(first.stdout, second.stdout);
  assert.equal(first.stderr, "");
});

test("the cohort split is the same on a host whose local time is not utc", async () => {
  const file = await fixture();
  const args = [
    CLI,
    "--input",
    file,
    "--since",
    "2026-09-01T22:39:16Z",
    "--supervisor-log-dir",
    recordsOf(file),
    "--quiet",
  ];
  const utc = await run(process.execPath, args, { env: { ...process.env, TZ: "UTC" } });
  const tokyo = await run(process.execPath, args, { env: { ...process.env, TZ: "Asia/Tokyo" } });
  const pacific = await run(process.execPath, args, {
    env: { ...process.env, TZ: "America/Los_Angeles" },
  });
  assert.equal(tokyo.stdout, utc.stdout);
  assert.equal(pacific.stdout, utc.stdout);
  assert.equal(JSON.parse(utc.stdout).before.startedRuns, 2);
  assert.equal(JSON.parse(utc.stdout).after.startedRuns, 2);
  assert.equal(
    JSON.parse(utc.stdout).after.liveness.classes.backstop.terminationInstants[0].instant,
    "2026-09-01T23:05:52.000Z",
  );
});

test("a read that fails exits non zero rather than reporting an empty history", async () => {
  const result = await run(process.execPath, [
    CLI,
    "--input",
    "does-not-exist.json",
    "--no-supervisor",
  ]).catch((error) => error);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /heartbeat health collection failed/);
});

test("an unknown option exits non zero and prints the usage", async () => {
  const result = await run(process.execPath, [CLI, "--nope"]).catch((error) => error);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /unknown option/);
});
