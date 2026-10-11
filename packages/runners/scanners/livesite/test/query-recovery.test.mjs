import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runLivesite } from "../run.mjs";
import { assignIncident } from "../lib/delivery.mjs";
import { assessQueryError } from "../lib/detect.mjs";

test("repeated query failures stay visible without repository preparation and recover on later scans", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "livesite-query-recovery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let scans = 0, lifecycle;
  const observations = [], failures = ["Azure authentication failed", "spawnSync cmd.exe ETIMEDOUT", "Azure DevOps 503"];
  await runLivesite(path.join(root, "run.mjs"), {
    config: { definitions: [{ id: 8228 }], pollSeconds: 0.01, agentId: "fixture" },
    once: false,
    onLifecycle(value) {
      lifecycle = value;
      const publish = value.publish;
      value.publish = update => { const result = publish(update); observations.push(result); return result; };
    },
    queue: {
      listIssues: async () => assert.fail("Monitoring failures must not claim a task workspace"),
      createIssue: async () => assert.fail("Monitoring failures must not create repair tasks"),
    },
    setupAgentBranch: async () => assert.fail("Monitoring failures must not prepare a repository"),
    queryBuilds: async () => {
      const scan = scans++;
      if (scan < failures.length) throw new Error(failures[scan]);
      if (scan === 4) lifecycle.stop();
      return [{ id: "1", status: "completed", result: "succeeded", queueTime: new Date().toISOString() }];
    },
    queryTimeline: async () => assert.fail("Passing builds need no failure timeline"),
  });
  assert.equal(scans, 5);
  assert.equal(observations.length, 5);
  for (let index = 0; index < 3; index++) {
    assert.equal(observations[index].lastError, failures[index]);
    assert.equal(observations[index].lastScan, null);
    assert.equal(observations[index].assigned, 0);
    assert.equal(observations[index].queued, 0);
    assert.equal(observations[index].phase, "degraded");
  }
  for (const observation of observations.slice(3)) {
    assert.equal(observation.lastError, null);
    assert.equal(observation.lastScan, observation.lastAttempt);
    assert.equal(observation.phase, "ready");
  }
  const state = JSON.parse(fs.readFileSync(path.join(root, ".runner", "state.json"), "utf8"));
  assert.equal(state.consecutiveScanFailures, 0);
  assert.deepEqual(state.alerts, {});
});

test("the delivery boundary rejects monitor failures even if a caller forgets the actionable guard", async () => {
  await assert.rejects(assignIncident({}, assessQueryError(new Error("az login required")), 1, {
    setupAgentBranch: async () => assert.fail("Must not prepare"),
    queue: { createIssue: async () => assert.fail("Must not dispatch") },
  }), /Non-actionable monitor failures/);
});
