import test from "node:test";
import assert from "node:assert/strict";

import { buildPark, readWakePaths, assertWakePath, PARK_WAKE_PATHS } from "../src/park.js";
import { createMemoryQueue } from "../src/queue/memory-queue.js";
import { createPaperclipQueue } from "../src/queue/paperclip-queue.js";

const owner = { agentId: "53b48af2-c09a-4a4c-9c3c-76d0d73ef419" };
const action = "raise the concurrency cap, then move this back to todo";

test("a park with a blocker names the blocker wake path and records the owner and action", () => {
  const park = buildPark({ blockedByIssueIds: ["off-68"], owner, action });
  assert.deepEqual(park.wakePaths, [PARK_WAKE_PATHS.BLOCKER]);
  assert.deepEqual(park.update, {
    status: "blocked",
    blockedByIssueIds: ["off-68"],
    unblockDescriptor: { owner, action },
  });
  assert.equal(park.monitorNextCheckAt, null);
});

test("a park with only a scheduled monitor is a legal park", () => {
  const park = buildPark({ monitorNextCheckAt: "2026-09-02T03:00:00Z", owner: "board", action });
  assert.deepEqual(park.wakePaths, [PARK_WAKE_PATHS.MONITOR]);
  assert.deepEqual(park.update.blockedByIssueIds, []);
  assert.equal(park.monitorNextCheckAt, "2026-09-02T03:00:00Z");
  assert.equal(park.update.unblockDescriptor.owner, "board");
});

test("a park with neither a blocker nor a monitor is refused before it reaches the queue", () => {
  assert.throws(() => buildPark({ owner, action }), /needs a wake path/);
  assert.throws(() => buildPark({ blockedByIssueIds: [], owner, action }), /needs a wake path/);
  assert.throws(
    () => buildPark({ monitorNextCheckAt: "not an instant", owner, action }),
    /needs a wake path/,
  );
});

test("a park with no unblock owner or no action is refused", () => {
  assert.throws(() => buildPark({ blockedByIssueIds: ["a"], action }), /unblock owner/);
  assert.throws(() => buildPark({ blockedByIssueIds: ["a"], owner: {}, action }), /unblock owner/);
  assert.throws(() => buildPark({ blockedByIssueIds: ["a"], owner }), /unblock action/);
  assert.throws(
    () => buildPark({ blockedByIssueIds: ["a"], owner, action: "   " }),
    /unblock action/,
  );
});

test("a repeated or blank blocker reference does not change the park", () => {
  const park = buildPark({ blockedByIssueIds: ["a", "a", " ", "b"], owner, action });
  assert.deepEqual(park.update.blockedByIssueIds, ["a", "b"]);
});

test("a monitor instant given as a date is carried as an instant", () => {
  const park = buildPark({
    monitorNextCheckAt: new Date("2026-09-02T03:00:00Z"),
    owner: { userId: "local-board" },
    action,
  });
  assert.equal(park.monitorNextCheckAt, "2026-09-02T03:00:00.000Z");
});

test("reading a park back reports the wake paths it actually has", () => {
  assert.deepEqual(readWakePaths({ blockedByIssueIds: ["a"] }).wakePaths, [PARK_WAKE_PATHS.BLOCKER]);
  assert.deepEqual(readWakePaths({ blockedBy: [{ id: "a" }] }).wakePaths, [PARK_WAKE_PATHS.BLOCKER]);
  assert.deepEqual(readWakePaths({ monitorNextCheckAt: "2026-09-02T03:00:00Z" }).wakePaths, [
    PARK_WAKE_PATHS.MONITOR,
  ]);
  const none = readWakePaths({ blockedBy: [], monitorNextCheckAt: null });
  assert.equal(none.hasWakePath, false);
  assert.equal(none.blockerCount, 0);
});

test("a monitor instant already in the past is still a scheduled monitor", () => {
  assert.equal(readWakePaths({ monitorNextCheckAt: "1999-01-01T00:00:00Z" }).hasWakePath, true);
});

test("the unblock owner reads as recorded only when both the owner and the action are there", () => {
  assert.equal(readWakePaths({ blockedByIssueIds: ["a"] }).unblockOwnerRecorded, false);
  assert.equal(
    readWakePaths({ blockedByIssueIds: ["a"], unblockDescriptor: { owner } }).unblockOwnerRecorded,
    false,
  );
  assert.equal(
    readWakePaths({ blockedByIssueIds: ["a"], unblockDescriptor: { owner, action } })
      .unblockOwnerRecorded,
    true,
  );
});

test("asserting a wake path throws on a park nothing can undo", () => {
  assert.throws(() => assertWakePath({ blockedBy: [], monitorNextCheckAt: null }), /nothing can wake it/);
  assert.equal(assertWakePath({ blockedByIssueIds: ["a"] }).hasWakePath, true);
});

test("the memory queue refuses to park work with no wake path", async () => {
  const queue = createMemoryQueue({ issues: [{ id: "one", status: "in_progress" }] });
  await assert.rejects(() => queue.parkIssue("one", { owner, action }), /needs a wake path/);
  const parked = await queue.parkIssue("one", { blockedByIssueIds: ["two"], owner, action });
  assert.equal(parked.status, "blocked");
  assert.deepEqual(parked.blockedByIssueIds, ["two"]);
  assert.deepEqual(parked.unblockDescriptor, { owner, action });
});

test("the queue client sends the blocker relation and the descriptor on one write", async () => {
  const sent = [];
  const queue = createPaperclipQueue({
    baseUrl: "https://example.test",
    apiKey: "key",
    companyId: "co",
    runId: "run",
    sourceIssueId: "source-issue",
    env: {},
    fetchImpl: async (url, init) => {
      sent.push({ url, method: init.method, body: JSON.parse(init.body) });
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: "one", status: "blocked" }) };
    },
  });

  await assert.rejects(() => queue.parkIssue("one", { owner, action }), /needs a wake path/);
  assert.equal(sent.length, 0, "a refused park never reaches the endpoint");

  const result = await queue.parkIssue("one", {
    blockedByIssueIds: ["two"],
    owner,
    action,
    comment: "waiting on the cap change",
  });
  assert.equal(sent[0].method, "PATCH");
  assert.equal(sent[0].url, "https://example.test/api/issues/one");
  assert.deepEqual(sent[0].body, {
    status: "blocked",
    blockedByIssueIds: ["two"],
    unblockDescriptor: { owner, action },
    comment: "waiting on the cap change",
  });
  assert.deepEqual(result.wakePaths, [PARK_WAKE_PATHS.BLOCKER]);
  assert.equal(result.issue.status, "blocked");
});

test("a monitor only park is carried back rather than sent to an endpoint that does not take it", async () => {
  const sent = [];
  const queue = createPaperclipQueue({
    baseUrl: "https://example.test",
    apiKey: "key",
    companyId: "co",
    runId: "run",
    sourceIssueId: "source-issue",
    env: {},
    fetchImpl: async (url, init) => {
      sent.push(JSON.parse(init.body));
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: "one" }) };
    },
  });
  const result = await queue.parkIssue("one", {
    monitorNextCheckAt: "2026-09-02T03:00:00Z",
    owner: "board",
    action,
  });
  assert.equal("monitorNextCheckAt" in sent[0], false);
  assert.equal(result.monitorNextCheckAt, "2026-09-02T03:00:00Z");
  assert.deepEqual(result.wakePaths, [PARK_WAKE_PATHS.MONITOR]);
});

/**
 * parkIssue is an attributed write, so a timer woken run cannot send one. Without this the park
 * surface inherits whatever run the suite happens to be started from, and the two tests above pass
 * or fail on the machine's environment rather than on the park contract.
 */
test("a park from a run with no source issue is held rather than sent", async () => {
  const sent = [];
  const queue = createPaperclipQueue({
    baseUrl: "https://example.test",
    apiKey: "key",
    companyId: "co",
    runId: "run",
    sourceIssueId: null,
    env: {},
    fetchImpl: async (url, init) => {
      sent.push(JSON.parse(init.body));
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: "one" }) };
    },
  });

  const held = await queue
    .parkIssue("one", { blockedByIssueIds: ["two"], owner, action })
    .then(() => null, (thrown) => thrown);
  assert.equal(held.held, true);
  assert.equal(held.code, "cross_issue_influence_run_context_required");
  assert.deepEqual(sent, [], "a held park must never leave the process");
});
