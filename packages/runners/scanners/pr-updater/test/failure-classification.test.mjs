/**
 * How a failing build is classified.
 *
 * This is the rule that was wrong in production. A deterministic lint break on one branch was
 * requeued indefinitely and never reached an agent, for two compounding reasons: the retry ledger
 * was keyed on the build id, which changes on every requeue, and any first failure was assumed
 * transient. Both are asserted here.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyFailures, infrastructureFailure, transientPolicies } from "../lib/build-failures.mjs";
import { evaluate } from "../lib/triggers.mjs";
import { rememberRequeue, requeuedFor } from "../lib/state.mjs";

const NOW = "2026-03-01T12:00:00.000Z";
const lint = { id: 100, name: "Code Format Validation", evaluationId: "eval-lint", result: "failed" };
const compliance = { id: 200, name: "Compliance", evaluationId: "eval-comp", result: "failed" };
const green = { id: 300, name: "CI Build", evaluationId: "eval-ci", result: "succeeded" };
const expired = { id: 400, name: "Buddy Build", evaluationId: "eval-buddy", result: "canceled", timedOut: true };

const provisioning = "Remote machine provider issue: The agent did not connect within the alloted time of 45 minute(s).";
const canceledJob = { type: "Job", result: "canceled", startTime: null, issues: [{ type: "error", message: provisioning }] };

test("infrastructure classification requires a canceled build and explicit unstarted-agent evidence", () => {
  const build = { status: "completed", result: "canceled" };
  assert.equal(infrastructureFailure(build, [canceledJob]), provisioning);
  assert.equal(infrastructureFailure({ ...build, result: "failed" }, [canceledJob]), null);
  assert.equal(infrastructureFailure(build, []), null);
  assert.equal(infrastructureFailure(build, [{ ...canceledJob, startTime: NOW }]), null);
  assert.equal(infrastructureFailure(build, [{ ...canceledJob, issues: [] }]), null);
  assert.equal(infrastructureFailure(build, [canceledJob, { type: "Task", result: "failed" }]), null);
  assert.equal(infrastructureFailure(build, [canceledJob, {
    issues: [{ type: "error", message: "Compilation failed" }],
  }]), null);
  assert.throws(() => infrastructureFailure(build, undefined), /Invalid build timeline/);
});

test("confirmed infrastructure failures get one policy retry and never become code repair", () => {
  const blocked = { ...compliance, failureKind: "infrastructure" };
  assert.deepEqual(classifyFailures([blocked]).requeue, [blocked]);
  for (const id of [200, 201, 202]) {
    const result = classifyFailures([{ ...blocked, id }], { retried: { "eval-comp": 200 } });
    assert.deepEqual(result, { requeue: [], escalate: [] });
  }
  const actualFailure = classifyFailures([{ ...compliance, id: 201 }], { retried: { "eval-comp": 200 } });
  assert.equal(actualFailure.escalate.length, 1);
});

test("a gate red on one branch alone is not transient", () => {
  const names = transientPolicies({ "1": [lint, green], "2": [green] });
  assert.equal(names.size, 0);
});

test("a gate red on several branches is transient", () => {
  const names = transientPolicies({ "1": [compliance], "2": [compliance], "3": [green] });
  assert.deepEqual([...names], ["Compliance"]);
});

test("a lone lint failure escalates immediately, with no requeue", () => {
  const { requeue, escalate } = classifyFailures([lint, green], { retried: {}, transientNames: new Set() });
  assert.equal(requeue.length, 0, "a deterministic failure must not be retried");
  assert.deepEqual(escalate.map((build) => build.name), ["Code Format Validation"]);
});

test("a fleet-wide failure is requeued rather than escalated", () => {
  const transientNames = new Set(["Compliance"]);
  const { requeue, escalate } = classifyFailures([compliance], { retried: {}, transientNames });
  assert.deepEqual(requeue.map((build) => build.name), ["Compliance"]);
  assert.equal(escalate.length, 0);
});

test("an expired build is requeued whatever else is happening", () => {
  const { requeue } = classifyFailures([expired], { retried: {}, transientNames: new Set() });
  assert.deepEqual(requeue.map((build) => build.name), ["Buddy Build"]);
});

test("an overnight expiry still reporting queued is requeued", () => {
  // Observed live on three gates at once: Azure DevOps leaves an expired evaluation in `queued`,
  // so reading only the result skipped it and the nightly requeue never fired.
  const stale = { id: 500, name: "Compliance", evaluationId: "eval-comp", result: "queued", timedOut: true };
  const { requeue, escalate } = classifyFailures([stale], { retried: {}, transientNames: new Set() });
  assert.deepEqual(requeue.map((build) => build.id), [500]);
  assert.equal(escalate.length, 0, "an expired clock is never the branch's fault");
});

test("an expiry is requeued again even after an earlier retry on the same commit", () => {
  // Live on pull request 5650245: three gates expired days after a first requeue, and the ledger
  // treated the second sighting as attributable, so an agent was sent to fix a build that had
  // never run instead of the script simply queueing it again.
  const again = { id: 501, name: "Compliance", evaluationId: "eval-comp", result: "queued", timedOut: true };
  const { requeue, escalate } = classifyFailures([again], { retried: { "eval-comp": 500 }, transientNames: new Set() });
  assert.deepEqual(requeue.map((build) => build.id), [501]);
  assert.equal(escalate.length, 0);
});

test("an expiry whose requeue has not produced a new build yet is left alone", () => {
  const same = { id: 500, name: "Compliance", evaluationId: "eval-comp", result: "queued", timedOut: true };
  const { requeue, escalate } = classifyFailures([same], { retried: { "eval-comp": 500 }, transientNames: new Set() });
  assert.equal(requeue.length, 0, "requeuing the same build every pass is a retry loop");
  assert.equal(escalate.length, 0);
});

test("an expiry is not counted as a fleet-wide failure", () => {  const stale = { id: 500, name: "Compliance", result: "queued", timedOut: true };
  assert.equal(transientPolicies({ "1": [stale], "2": [stale] }).size, 0);
});

test("a healthy running build is left alone", () => {
  const running = { id: 600, name: "CI Build", result: "queued" };
  const { requeue, escalate } = classifyFailures([running], { retried: {}, transientNames: new Set() });
  assert.equal(requeue.length, 0);
  assert.equal(escalate.length, 0);
});

test("a requeued failure that reproduces under a new build id escalates", () => {
  // The live bug: after a requeue Azure DevOps reports the same policy with a different build id.
  const retried = { "eval-comp": 200 };
  const again = { ...compliance, id: 201 };
  const { requeue, escalate } = classifyFailures([again], { retried, transientNames: new Set(["Compliance"]) });
  assert.equal(requeue.length, 0, "a retried policy is never retried twice on the same revision");
  assert.deepEqual(escalate.map((build) => build.id), [201]);
});

test("the same build id after a requeue is still waiting, not reproduced", () => {
  const retried = { "eval-comp": 200 };
  const { requeue, escalate } = classifyFailures([compliance], { retried, transientNames: new Set(["Compliance"]) });
  assert.equal(requeue.length, 0);
  assert.equal(escalate.length, 0, "the retry has not produced a new build yet");
});

test("the ledger survives a requeue because it is keyed on the policy", () => {
  const state = { builds: {} };
  const pr = { id: "5626012", sourceCommit: "abc" };
  rememberRequeue(state, pr, compliance);
  const retried = requeuedFor(state, pr);
  assert.equal(retried["eval-comp"], 200);

  // The next pass sees a new build id for the same policy and must recognise it as a retry.
  const { requeue } = classifyFailures([{ ...compliance, id: 999 }], { retried, transientNames: new Set(["Compliance"]) });
  assert.equal(requeue.length, 0, "the endless requeue loop must not recur");
});

test("a push clears the ledger so new code gets its own retry", () => {
  const state = { builds: {} };
  rememberRequeue(state, { id: "5626012", sourceCommit: "abc" }, compliance);
  assert.deepEqual(requeuedFor(state, { id: "5626012", sourceCommit: "def" }), {});
});

test("evaluate escalates a lone failure without waiting for a retry", () => {
  const verdict = evaluate({
    pr: { id: "1", mergeStatus: "succeeded", sourceCommit: "abc" },
    builds: [lint],
    now: NOW,
    config: {},
    retried: {},
    transientNames: new Set(),
  });
  assert.equal(verdict.trigger, "build");
  assert.ok(verdict.reason.includes("Code Format Validation"));
});

test("evaluate stays quiet while a transient failure is being retried", () => {
  const verdict = evaluate({
    pr: { id: "1", mergeStatus: "succeeded", sourceCommit: "abc" },
    builds: [compliance],
    now: NOW,
    config: {},
    retried: {},
    transientNames: new Set(["Compliance"]),
  });
  assert.equal(verdict, null);
});
