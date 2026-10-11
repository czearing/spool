# bohemia-agent-tooling

Shared scaffold for agent operations tools. A tool is a configuration of this scaffold, not a copy
of it.

## The tool shape

Every tool built here is a command line entry point with no interface. One run is one cycle, and the
cycle always runs the same ordered steps:

1. wake, read the append only telemetry log and derive what is still open
2. read results back from the issues that were opened on an earlier cycle
3. ask the gate whether there is anything to do, when the tool is driven by change rather than time
4. collect, using collectors the tool supplies
5. select at most one candidate, using a threshold rule
6. write at most one issue to the queue
7. append one telemetry record for the cycle and one for every task transition

An empty cycle is a normal result. A cycle that finds no candidate above the threshold, and a cycle the
gate refused, both still append a cycle record and write no issue.

A tool's only outputs are the append only telemetry log and the issues it writes. A view, if one is
ever wanted, reads the telemetry log and stays out of the execution path.

## What is shared and what is not

Shared here: the wake, the trigger gate, the collection interface, the candidate selection interface
with the queue cap, the telemetry writer, the issue writer, the acceptance check, the park guard that
every tool parking work goes through, and the numeric readings every collector repeats, which are the
instant arithmetic, the chain walk over rows that point at other rows, and the wake path walk over
rows that wait on other rows.

Not shared: what a tool measures, how it ranks what it measured, and what its issue says. Metric
collection lives in the tool, and so does the wording of a task that carries more than one number.

## The runner shape

Not every tool is one cycle. A tool that watches something outside itself runs as a process and polls,
and the shared question changes from "what did the cycle do" to "is this runner alive, is it still
working, and did the work it decided on actually reach an agent". Two surfaces answer that, and both
are configured rather than copied.

Supervision is read from files the runner writes, never from a live handle, so any command line can
answer without owning the process. A runner is any directory holding a `runner.json` naming itself and
its entry point. A process that exists but has not scanned within its own poll budget is reported
running and stale, because a supervisor that called it healthy is exactly how a dead delivery path
stays hidden.

The handoff ledger is the record of what was given to whom. It is append only, written by the tool, and
carries one of five transitions: handed, accepted, closed, refused, held. A held
handoff records intentional deferral (for example an occupied workspace), not delivery
or a failed API call. Reading this back from the queue is
not an answer, because a task that was never created leaves no trace there at all, which is precisely
the failure the ledger exists to make visible. A refused handoff is a failure even when the cycle that
produced it reported success.

`runManagedRunner(import.meta.url, initialize)` owns process-lifetime singleton
locking, PID identity, atomic runtime records, serial polling and graceful stops.
Call `runner.poll({ scan, intervalMs })` inside initialization; `scan` returns its
observations or calls `runner.publish(observations)`. Throw on failure. The lifecycle
preserves the last successful observations, writes `lastError`, and retries after
the configured interval (or a longer `retryAfterMs`). `onError` may add runner-specific
reporting, without hiding the failure. Do not write PID/status files or add another
polling loop in a runner.

`startRunner(manifest)` confirms a fresh, successful scan for the current instance;
a timeout reports failure without terminating active work. `requestRunnerStop(entry, pid)`
asks that exact owner to finish its current scan and stop. Windows process identity
checking is shared by the launcher and reporting commands. Runtime readers retain
compatibility with legacy `error` and `blocked.error` records.

```js
import {
  discoverRunners,
  readAllRunnerStates,
  createHandoffLedger,
  handoffRollup,
  handoffFailures,
} from "bohemia-agent-tooling";

const ledger = createHandoffLedger({ path, tool: "pr-reviewer" });
ledger.append("handed", { taskKey, agent, issueId, title });
const stillWaiting = handoffFailures(ledger.read());
```

## Configuration surface

```js
import {
  runWake,
  createTelemetryWriter,
  createMarkStore,
  defineChangeGate,
  defineCollector,
  defineThresholdSelector,
  defineOpenCapSelector,
  createPaperclipQueue,
} from "bohemia-agent-tooling";

const code = await runWake({
  tool: "perf-engine",
  telemetry: createTelemetryWriter({ path, tool: "perf-engine" }),
  queue: createPaperclipQueue({ baseUrl, apiKey, companyId, runId }),
  collectors: [defineCollector({ name: "graph", collect: () => observations })],
  selector: defineOpenCapSelector({
    selector: defineThresholdSelector({ minGapRatio: 0.1 }),
    countOpen: () => openTaskCount,
    maxOpenTasks: 3,
  }),
  gate: defineChangeGate({ store: createMarkStore({ path: markPath }), readCurrent: () => head }),
  renderTask: (candidate) => ({ title, body }),
  assigneeAgentId,
  parentIssueId,
  bodyBudget: 900,
});
```

A collector returns observations. An observation must carry `metric`, `current`, `target`,
`acceptance`, `unit` and `reproduction`. An observation without a finite current number never becomes
a task, whatever renderer the tool supplies.

The gate is optional and generic. It never learns what a mark is: the tool reads the mark, says whether
the move between two marks is relevant, and says whether a finished cycle accounted for the change. A
tool driven by time passes no gate at all.

The queue cap wraps any selection rule and refuses a candidate once open tasks reach the cap, so a run
of cycles cannot stack unfinished tasks on one assignee.

## A brief the tool wrote is a brief the tool can correct

The numbers on an open task keep moving after the task is written, so a brief that was right when it
left the tool is wrong a few cycles later, and the agent holding it is working to a number nothing
measures. The cycle therefore rewrites the brief of an open task whose numbers drifted, using the same
renderer that wrote it. This is the task out channel a second time, not a new one: no comment is
posted and no agent is pinged.

The write is field scoped by construction. Only the title and the description leave the tool. Status,
result and every other field the running assignee owns are never in the payload.

A queue may refuse the write while the assignee holds a live run checkout. That refusal is a schedule
rather than a failure: the correction is recomputed from fresh numbers and offered again on the next
wake, and it lands as soon as the run lock clears, which is before the assignee reads the task again.
Every attempt appends a telemetry transition, `corrected`, `correction_deferred` or
`correction_refused`, so the record shows what the tool tried and when it landed.

Only a correction that cannot land is a defect. A stale brief the tool put right is settled, so the
tool owner is told nothing, and a deferral becomes a defect once it has been refused
`correctionDeferralLimit` times, three by default. A tool that must not rewrite its own briefs sets
`correctBriefs: false` and keeps the older behaviour, where the first drift is reported as a defect.

## A write on an existing issue is attributed to the run that made it

The queue attributes every write on an issue that already exists to the run behind it, and it refuses
a write from a run it cannot attribute. A tool woken by a timer has a run and no issue of its own, so
its writes arrive with nothing to attribute them to and are refused with
`cross_issue_influence_run_context_required` on every wake, whatever header they carry.

That refusal is not a lock and not a wall. A lock clears when a run ends and the cycle waits it out.
This one clears when the tool next runs from a run woken on an issue, so retrying it from another
timer woken run is certain to be refused again and counting those attempts against the deferral limit
turns a wait into a false defect.

So an unattributable write is held. `readRunContext` reads the run id and the source issue from the
wake environment, `guardIssueWrites` wraps the queue, and `createPaperclipQueue` applies both by
default. A held write is never sent, never counted as a failure, and never handed to the tool owner:
it appends a `correction_held` transition and waits. Reads and issue creation are untouched, because
a new issue is not influence on an issue someone else is holding.

Nothing is stored between the two runs. The cycle recomputes the same correction from the record and
the collection every wake, so the run that can attribute the write sends the numbers measured then,
never a number kept on the side to go stale.

| What the run has | What a write on an existing issue does |
| --- | --- |
| A run id and a source issue | Sent, and attributed to that run |
| A run id and no source issue, which is every timer woken cycle | Held, recorded, offered again next wake |
| No run id at all | Held, recorded, offered again next wake |

## Parking work is a write with a precondition

Moving an issue to blocked is a claim that something else will move it back. A park with no first
class blocker and no scheduled monitor is not a park, it is an abandonment, and it reads identically
to a park that is simply waiting. Every issue waiting on that one is parked with it.

So the queue refuses it. `parkIssue` builds the write through the shared park guard, which requires at
least one wake path and requires the unblock owner and action to be recorded in a field rather than in
prose. A caller that cannot name either finds out at the call site instead of in a board sweep days
later. This is the issue write channel, not a new one: no comment is posted and no agent is pinged.

```js
import { buildPark, readWakePaths, assertWakePath } from "bohemia-agent-tooling";

await queue.parkIssue(issueId, {
  blockedByIssueIds: [blockerId],
  owner: { agentId },
  action: "raise the cap, then move this back to todo",
});
```

`readWakePaths` answers the same question for one row a tool did not write, and `analyzeWakePaths`
answers it for a population: which parked rows have no way back, which of those something else is
waiting on, and how many rows are stranded behind them. The walk asks the caller what parked means and
what counts as waking, so two tools counting stranded chains produce comparable numbers.

## Issue bodies stay small

The local adapter passes an issue description on the command line, and a long description fails the
wake. The issue writer holds a task body under a fixed character budget and refuses to write one that
does not fit.

## Tools in this tree

An operator collector that no single product tool owns lives under `tools/`. It is a command line
entry point with no interface, it writes its record to stdout and a small table to stderr, and it
computes from recorded columns only so two runs against unchanged history return byte identical
output.

### heartbeat-health

Heartbeat run health as one record per query: the process lost share over started runs, lost and
finished run minutes with the discarded share between them, the succeeded share over finished runs,
and the grouped error signatures with counts. The same command answers the whole history and an
arbitrary cutoff window.

It also reports per run liveness at termination, for every run that was ended by something other than
itself, split into the backstop, process lost and error classes:

- the quiet gap between the last recorded output and the finish, per run and as a minimum, maximum
  and mean per class
- the count and share of those runs inside the ten minute output recency guard, which is the standard
  that says a run producing output is alive
- the count of those runs that produced no output at all
- the termination instants grouped to the second, with the run count and the distinct agent count at
  each one, which separates one decision taken against a batch from a batch of independent failures
- the share of process lost runs whose last output sits within two minutes of a backstop instant,
  which says whether two detectors are counting one event twice

A negative quiet gap means output was recorded after the finish instant, which is inside the guard by
the same standard.

It reports the wake chain as well, which is the population a retry policy is scored on. A chain is a
root run plus every run linked to it through the retry link, so one chain is one wake however many
attempts it took. A chain is settled when its last run is not running and no retry is scheduled for
it, and a settled chain whose last run was lost and was never retried is abandoned. For every
abandoned chain the command reports the attempts, the retry count, whether that count sits at the cap,
and the recorded abandonment reason, which is the only column that separates a policy that stopped on
purpose from a retry that has simply not started yet. A run whose root started before the window is
counted as one chain rather than dropped, and marked as starting outside the window.

The blocked issues are read as well, so the board side clauses are scored from the same command. Three
numbers come out of it and they are not the same reading. A blocked issue with an empty blocker
relation and no scheduled monitor has no wake path of its own. A dead end that something else is
waiting on is a chain terminal, and the fault reaches past the issue it sits on. The stranded count is
every blocked issue whose whole blocker closure is dead, which is what one dead end actually costs. The
command also reports how many stranded issues record no unblock owner and action, which is the only
column separating a chain that is stranded from one that is merely waiting. Pass `--no-issues`, or read
from a saved file with `--input`, to skip that read, in which case the board clauses score null rather
than passing by default.

The blocker graph is walked over every blocked issue on the board rather than over the cutoff window,
because whether a chain can resume is a fact about the board now and not about when its rows were
parked. Only the transition clause is bounded by `--since`.

The command also reads the supervisor's own record of what it did on startup, and it finds that record
itself. Every record file in the runtime's directory is read, and each one is placed on the calendar
from the rows it names: a line that reaps or terminalizes a run is the same write that set that run's
finish instant, so pairing the line's time of day with the recorded instant fixes both the day the
record covers and the offset it was written at. The placed records are merged into one reading, so a
cohort that crosses midnight or a supervisor restart into a new file is still one population. A record
that names runs in the cohort and cannot be placed fails the command, because a reading that quietly
drops a supervisor restart scores zero of zero and reads as a pass. Pass `--supervisor-log-dir` to read
a different directory, `--no-supervisor` to refuse the read and leave its two clauses unscored, or
`--supervisor-log` with `--supervisor-log-date` and `--supervisor-log-offset` to read exactly one file
with the day and offset supplied by hand.

The guard holes it reports are split by the path that terminalized them and by whether that path
recorded any authority at all, because a path that recorded a wrong reading and a path that recorded
no reading are different defects and only the second leaves nothing to repair against.

```
node tools/heartbeat-health/cli.js [--since <iso>] [--as-of <iso>] [--limit <n>] [--agent <id>] [--input <file>] [--snapshot <file>] [--no-issues] [--supervisor-log-dir <dir>] [--no-supervisor] [--quiet]
```

No caller handles a timestamp. The cutoff and every row instant go through the shared instant
surface, which reads an offset free string as UTC, so the cohort split is the same on a host whose
local time is not UTC. Reading these timestamps with a local zone parser is what inverted the cohorts
in the hand passes this collector replaces.

The endpoint is mutable. A run that was still running when a number was read carries an error, a
finish instant and a terminal status on the next read, so the same cutoff returns a larger lost cohort
every time and a number quoted from an earlier read cannot be checked. `--snapshot` freezes the rows a
reading was taken from so it can be re-scored with `--input`. `--as-of` recovers a reading taken before
any snapshot existed, by reading the rows back as the endpoint would have returned them at that
instant: a run whose finish, error or last output is stamped at or after the instant had not reached
that state yet, and a run that had not started is dropped. It uses recorded columns only and invents
nothing.

Metric collection stays in the tool. The shared core never learns what a heartbeat run is.

## Tests

One test file per protocol surface. A surface with no test is an unowned surface.

| Surface | Test file |
| --- | --- |
| Wake | test/wake.test.js |
| Trigger gate | test/gate.test.js |
| Collection | test/collect.test.js |
| Selection and the queue cap | test/select.test.js |
| Telemetry append | test/telemetry.test.js |
| Issue write | test/issue-writer.test.js |
| Acceptance check | test/acceptance.test.js |
| Process supervision | test/supervisor.test.js |
| Handoff ledger | test/handoff.test.js |
| Queue client | test/queue.test.js |
| Run attribution and the write guard | test/run-context.test.js |
| Instants, cohort split, grouping and correlation | test/instants.test.js |
| Chain linking over parent links | test/chains.test.js |
| Wake path walk over blocking links | test/wake-paths.test.js |
| Park guard and the park write | test/park.test.js |
| Heartbeat health collection | test/heartbeat-health.test.js |
| Heartbeat health command line | test/heartbeat-health-cli.test.js |
| Heartbeat health wake chains | test/heartbeat-health-chains.test.js |
| Heartbeat health blocked issue read | test/heartbeat-health-issues.test.js |
| Heartbeat health blocked chain wake paths | test/heartbeat-health-blocked-wake-paths.test.js |
| Heartbeat health as of projection | test/heartbeat-health-as-of.test.js |
| Heartbeat health supervisor record read | test/heartbeat-health-supervisor-log.test.js |
| Heartbeat health supervisor record discovery | test/heartbeat-health-supervisor-discovery.test.js |

```
npm test
```

## Ownership

This repository is written by the tooling engineer only. A tool owner configures it and does not
commit to it. A defect in the shared scaffold is filed as an issue to the tooling engineer.
