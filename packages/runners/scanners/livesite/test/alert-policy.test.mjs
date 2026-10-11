import assert from "node:assert/strict";
import test from "node:test";
import { alertDue, markRecoveredAlerts, migrateLegacyAlerts } from "../lib/alert-policy.mjs";

const now = new Date("2026-07-24T23:30:00Z");

test("deduplicates one incident during its cooldown", () => {
  const assessment = { key: "regression:8228:same-failure" };
  const state = {
    alerts: {
      [assessment.key]: {
        assignedAt: "2026-07-24T22:30:00Z",
        attempt: 1,
        submissionId: "attempt-1",
      },
    },
  };
  assert.equal(alertDue(state, assessment, now, 6), false);
});

test("a healthy build reopens matching alerts for immediate recurrence", () => {
  const key = "regression:8228:same-failure";
  const state = {
    alerts: {
      [key]: {
        assignedAt: "2026-07-24T22:30:00Z",
        attempt: 1,
        submissionId: "attempt-1",
      },
      "regression:9000:other-failure": {
        assignedAt: "2026-07-24T22:30:00Z",
        attempt: 1,
        submissionId: "other-attempt-1",
      },
    },
  };
  markRecoveredAlerts(state, [{
    kind: "healthy",
    build: {
      definitionId: 8228,
      finishTime: "2026-07-24T23:18:51Z",
    },
  }], now);
  assert.equal(state.alerts[key].recoveredAt, "2026-07-24T23:18:51Z");
  assert.equal(state.alerts[key].attempt, 1);
  assert.equal(state.alerts["regression:9000:other-failure"].recoveredAt, undefined);
  assert.equal(alertDue(state, { key }, now, 6), true);
});

test("healthy builds do not reopen chronic FlakyTestAssassin capacity incidents", () => {
  const key = "flaky_capacity:8228:cap-2-unskipped-1";
  const state = {
    alerts: {
      [key]: {
        assignedAt: "2026-07-24T22:30:00Z",
        attempt: 1,
        submissionId: "attempt-1",
      },
    },
  };
  markRecoveredAlerts(state, [{
    kind: "healthy",
    build: { definitionId: 8228, finishTime: "2026-07-24T23:18:51Z" },
  }], now);

  assert.equal(state.alerts[key].recoveredAt, undefined);
  assert.equal(alertDue(state, { key, cooldownHours: 24 }, now, 6), false);
});

test("migrates the current legacy package-specific cap alert without a duplicate wake", () => {
  const oldKey = "flaky:8228:package-specific";
  const newKey = "flaky_capacity:8228:cap-2-unskipped-1";
  const state = {
    alerts: {
      [oldKey]: {
        assignedAt: "2026-07-24T22:30:00Z",
        attempt: 2,
        submissionId: "legacy-attempt-2",
      },
    },
    lastAssessment: {
      assessments: [{
        kind: "flaky",
        key: oldKey,
        summary: "FlakyTestAssassin reported: Flaky test cap exceeded (cache fallback)",
        build: { definitionId: "8228" },
      }],
    },
  };
  const assessment = {
    kind: "flaky_capacity",
    key: newKey,
    cooldownHours: 24,
    build: { definitionId: "8228" },
  };

  migrateLegacyAlerts(state, [assessment]);

  assert.equal(state.alerts[newKey].assignedAt, "2026-07-24T22:30:00Z");
  assert.equal(state.alerts[newKey].attempt, 2);
  assert.equal(state.alerts[newKey].migratedFrom, oldKey);
  assert.equal(alertDue(state, assessment, now, 6), false);
});
