/**
 * The five scenarios the updater exists to handle, asserted against the exact comment and policy
 * shapes measured on live office-bohemia pull requests.
 *
 * These are the tests that matter: every failure so far has been a pull request that quietly never
 * entered the queue, which no amount of unit coverage on the surrounding modules would have caught.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENCY,
  BUILD,
  CONFLICT,
  REVIEW,
  agencyFindings,
  evaluate,
  shouldSend,
} from "../lib/triggers.mjs";
import { classifyFailures } from "../lib/build-failures.mjs";

const AGENCY_ID = "e329845e-a08b-4356-8270-e641496e4aba";
const NOW = "2026-03-01T12:00:00.000Z";

const config = {
  agencyAuthorId: AGENCY_ID,
  authorAccount: "calebzearing@microsoft.com",
  agentAccount: "calebzearing@microsoft.com",
  botAccounts: ["office-fluid@microsoft.com", "office-fluid-pr@microsoft.com"],
  quietMinutes: 10,
  retryMinutes: 120,
};

const clean = { id: "1", mergeStatus: "succeeded", sourceCommit: "abc123" };

function minutesAgo(minutes) {
  return new Date(Date.parse(NOW) - minutes * 60_000).toISOString();
}

function humanThread(minutesAgoValue, content = "please rename this", author = "Christian Gonzalez") {
  return {
    id: 10,
    status: "active",
    comments: [{
      commentType: "text",
      content,
      publishedDate: minutesAgo(minutesAgoValue),
      author: { displayName: author, uniqueName: "chgonz@microsoft.com", id: "human-1" },
    }],
  };
}

function agencyThread(content, status = "active") {
  return {
    id: 20,
    status,
    comments: [{
      commentType: "text",
      content,
      publishedDate: minutesAgo(60),
      author: { displayName: "Agency", uniqueName: "", id: AGENCY_ID },
    }],
  };
}

test("scenario 1: an expired build is retried, never escalated", () => {
  const builds = [{ id: 7, name: "CI Build", evaluationId: "eval-7", result: "canceled", timedOut: true }];
  const { requeue, escalate } = classifyFailures(builds, { retried: {} });
  assert.equal(escalate.length, 0);
  assert.equal(requeue.length, 1);
  assert.equal(evaluate({ pr: clean, builds, now: NOW, config }), null);
});

test("scenario 2: a conflicted merge outranks every other signal", () => {
  const pr = { ...clean, mergeStatus: "conflicts" };
  const builds = [{ id: 7, name: "CI Build", result: "failed" }];
  const verdict = evaluate({
    pr,
    threads: [humanThread(30), agencyThread("**Blocking** null deref")],
    builds,
    now: NOW,
    config,
    retried: { "CI Build": 6 },
  });
  assert.equal(verdict.trigger, CONFLICT);
  assert.equal(verdict.fingerprint, "conflict:abc123");
});

test("scenario 3: a failure only this branch has escalates without a retry", () => {
  const builds = [{ id: 7, name: "CI Build", evaluationId: "eval-7", result: "failed" }];
  const verdict = evaluate({ pr: clean, builds, now: NOW, config });
  assert.equal(verdict.trigger, BUILD, "a lone failure is the branch's own");
  assert.equal(verdict.fingerprint, "build:abc123:7");

  // The same failure while the gate is red everywhere is the pipeline, so it waits for its retry.
  const transientNames = new Set(["CI Build"]);
  assert.equal(evaluate({ pr: clean, builds, now: NOW, config, transientNames }), null);
});

test("scenario 4: a human burst waits ten quiet minutes measured from the newest comment", () => {
  const early = evaluate({ pr: clean, threads: [humanThread(9)], now: NOW, config });
  assert.equal(early, null, "still typing");

  const ready = evaluate({ pr: clean, threads: [humanThread(11)], now: NOW, config });
  assert.equal(ready.trigger, REVIEW);

  // A second thought nine minutes into the first restarts the clock, so both are answered together.
  const restarted = evaluate({
    pr: clean,
    threads: [humanThread(25), { ...humanThread(9), id: 11 }],
    now: NOW,
    config,
  });
  assert.equal(restarted, null);
});

test("scenario 4: bots and the pull request's own author never count as review", () => {
  const bot = {
    id: 12,
    status: "active",
    comments: [{
      commentType: "text",
      content: "bundle report",
      publishedDate: minutesAgo(60),
      author: { displayName: "Office Fluid", uniqueName: "office-fluid@microsoft.com", id: "bot-1" },
    }],
  };
  assert.equal(evaluate({ pr: clean, threads: [bot], now: NOW, config }), null);
});

test("scenario 5: unresolved Agency findings are worth a turn at either severity", () => {
  const blocking = evaluate({ pr: clean, threads: [agencyThread("**Blocking** unhandled null")], now: NOW, config });
  assert.equal(blocking.trigger, REVIEW);
  assert.equal(blocking.fingerprint, `review:${agencyThread("**Blocking** unhandled null").comments[0].publishedDate}`);
  assert.match(blocking.reason, /Agency/);

  // Suggestions are specific and sometimes correct, so they are triaged rather than discarded.
  const suggestion = evaluate({ pr: clean, threads: [agencyThread("**Suggestion** tidy this")], now: NOW, config });
  assert.equal(suggestion.trigger, REVIEW);
  assert.match(suggestion.reason, /Agency/);
  assert.equal(agencyFindings([agencyThread("**Suggestion** tidy this")], config)[0].severity, "**Suggestion**");

  assert.equal(agencyFindings([agencyThread("**No issues found**")], config).length, 0);
  assert.equal(agencyFindings([agencyThread("**Blocking** x", "fixed")], config).length, 0, "resolved is answered");
});

test("the Agency summary comment carries no severity and never triggers a turn", () => {
  // Live shape: the "PR Review" report is posted by Agency as an active thread on every PR, so
  // treating any Agency comment as a finding would dispatch a turn on every pull request forever.
  const summary = agencyThread("**PR Review**\n<!-- post-pr-review:v1 type=summary -->\n**Target**: PR !5626012");
  assert.equal(agencyFindings([summary], config).length, 0);
  assert.equal(evaluate({ pr: clean, threads: [summary], now: NOW, config }), null);
});

test("scenario 5: a look-alike bot with the same shape is separated by identity", () => {
  const gitops = agencyThread("**Blocking** policy violation");
  gitops.comments[0].author = { displayName: "GitOps", uniqueName: "", id: "other-service" };
  assert.equal(agencyFindings([gitops], config).length, 0);
});

test("a human comment outranks an Agency finding on the same pull request", () => {
  const verdict = evaluate({
    pr: clean,
    threads: [humanThread(20), agencyThread("**Blocking** null deref")],
    now: NOW,
    config,
  });
  assert.equal(verdict.trigger, REVIEW);
});

test("the same cause is sent once, then offered again only after the retry window", () => {
  const verdict = { trigger: CONFLICT, reason: "merge conflict", fingerprint: "conflict:abc123" };
  assert.equal(shouldSend(verdict, undefined, NOW, config).retry, false, "never seen before");

  const sent = { fingerprint: "conflict:abc123", lastSentAt: minutesAgo(30) };
  assert.equal(shouldSend(verdict, sent, NOW, config), null, "already handled");

  const stale = { fingerprint: "conflict:abc123", lastSentAt: minutesAgo(180) };
  assert.equal(shouldSend(verdict, stale, NOW, config).retry, true, "nothing changed after two hours");

  const different = { fingerprint: "conflict:older", lastSentAt: minutesAgo(1) };
  assert.equal(shouldSend(verdict, different, NOW, config).retry, false, "new evidence always gets through");
});

test("a pull request with nothing outstanding produces no verdict", () => {
  assert.equal(evaluate({ pr: clean, threads: [], builds: [], now: NOW, config }), null);
  assert.equal(evaluate({ pr: clean, now: "not a date", config }), null);
});
