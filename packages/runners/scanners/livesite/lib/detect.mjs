const infrastructurePattern = /agent.*lost|connection|network|timeout|timed out|service unavailable|5\d\d|enospc|disk|registry|coverage upload|baseline|clean log file/i;
const testPattern = /storywright|visual regression|vrt|screenshot|playwright|jest|vitest|mocha|test:(?:e2e|compat|unit|integration)|flaky test|storm detected|\btests?\b/i;
const authPattern = /tf400813|sign in|authentication|authorization|az login|credential|http 203/i;

export function requiredTimelineIds(builds) {
  return ordered(builds)
    .filter((build) => build.status === "completed" && !["canceled", "succeeded", null].includes(build.result))
    .slice(0, 2)
    .map((build) => build.id);
}

export function assessBuilds(builds, timelines, now, config) {
  const sorted = ordered(builds);
  const stuck = sorted.find((build) => (
    build.status !== "completed"
    && ageMinutes(build.startTime || build.queueTime, now) >= config.stuckMinutes
  ));
  if (stuck) return actionable("stuck", stuck, `Running for ${Math.floor(ageMinutes(stuck.startTime || stuck.queueTime, now))} minutes`);

  const cancellations = sorted.slice(0, 3);
  if (cancellations.length === 3 && cancellations.every((build) => build.result === "canceled")) {
    return actionable("manual_action", cancellations[0], "Three newest builds were canceled");
  }

  const completed = sorted.filter((build) => (
    build.status === "completed" && !["canceled", null].includes(build.result)
  ));
  const latest = completed[0];
  if (!latest) return passive("unknown", sorted[0] || null, "No completed build result");
  if (latest.result === "succeeded") return passive("healthy", latest, "Latest completed build passed");

  const latestFailure = failureEvidence(timelines[latest.id] || []);
  // Azure rolls a continueOnError task up into the build result, so a build can look
  // failing while every gating step passed. Such a build has no record with
  // result=failed, and every one of them collapses to the same "Unknown failed build
  // step" key, which made any two in a row look like one repeating regression.
  // Warnings on a build that gated nothing are not an incident.
  if (!latestFailure.hasFailedRecord) {
    return passive("healthy", latest, "Only nonblocking task issues; no failed build step");
  }
  const capacitySignal = flakyCapacitySignal(latestFailure.flakySignals);
  if (capacitySignal) {
    return actionable(
      "flaky_capacity",
      latest,
      `FlakyTestAssassin capacity exceeded: ${capacitySignal.summary}`,
      { ...latestFailure, key: capacitySignal.key },
      { cooldownHours: config.flakyCapacityCooldownHours || 24 },
    );
  }
  if (latestFailure.flakySignals.length > 0) {
    return actionable("flaky", latest, `FlakyTestAssassin reported: ${latestFailure.flakySignals.join(" | ")}`, latestFailure);
  }
  const previous = completed[1];
  if (!previous || previous.result === "succeeded") {
    const minutes = ageMinutes(latest.finishTime || latest.startTime, now);
    if (minutes < config.persistentFailureMinutes) {
      return passive("watching", latest, `First failure is ${Math.floor(minutes)} minutes old`);
    }
    const kind = latestFailure.infrastructure ? "infrastructure" : "manual_action";
    return actionable(kind, latest, `${latestFailure.summary}; no recovery for ${Math.floor(minutes)} minutes`, latestFailure);
  }

  const priorFailure = failureEvidence(timelines[previous.id] || []);
  if (latestFailure.key === priorFailure.key && latestFailure.key !== "unknown") {
    const kind = latestFailure.infrastructure ? "infrastructure" : "regression";
    return actionable(kind, latest, `Repeated in builds ${previous.number} and ${latest.number}: ${latestFailure.summary}`, latestFailure);
  }
  if (latestFailure.testLike && priorFailure.testLike) {
    return actionable("flaky", latest, `Rotating test failures: ${priorFailure.summary} -> ${latestFailure.summary}`, latestFailure);
  }
  return actionable("multiple_failures", latest, `Consecutive distinct failures: ${priorFailure.summary} -> ${latestFailure.summary}`, latestFailure);
}

export function assessQueryError(error) {
  const summary = firstLine(error?.message || String(error));
  const kind = authPattern.test(summary) ? "auth_outage" : "monitor_error";
  return {
    actionable: false,
    kind,
    key: `${kind}:${stableKey(summary)}`,
    summary,
    build: null,
    evidence: null,
  };
}

export function assignmentPrompt(assessment) {
  const build = assessment.build;
  return [
    `Livesite incident: ${assessment.kind}`,
    build ? `Build ${build.number} (${build.id}): ${build.url}` : "Build data is unavailable.",
    `Evidence: ${assessment.summary}`,
    build ? `Source: ${build.sourceBranch || "unknown"} @ ${build.sourceVersion || "unknown"}` : "",
    "Add the owner of each touched package as a reviewer on the pull request.",
  ].filter(Boolean).join("\n");
}

function failureEvidence(records) {
  const failed = records.filter((record) => record.result === "failed");
  const messages = failed.flatMap((record) => record.issues.map(firstLine));
  const packageMatch = messages.join(" ").match(/packages?\s*=>\s*\[([^\]]+)\]/i);
  const summary = packageMatch?.[1] || messages[0] || failed[0]?.name || "Unknown failed build step";
  const combined = `${failed.map((record) => record.name).join(" ")} ${messages.join(" ")}`;
  const testLike = testPattern.test(combined);
  return {
    summary,
    hasFailedRecord: failed.length > 0,
    key: stableKey(testLike ? `${summary} ${combined}` : summary),
    infrastructure: infrastructurePattern.test(combined),
    testLike,
    flakySignals: records.flatMap((record) => record.issues).filter((message) => /flaky|storm detected/i.test(message)).slice(0, 3),
  };
}

function actionable(kind, build, summary, evidence = null, options = {}) {
  const signal = kind === "stuck" ? build?.id : evidence?.key || stableKey(summary);
  return {
    actionable: true,
    kind,
    key: `${kind}:${build?.definitionId || "none"}:${signal}`,
    summary,
    build,
    evidence,
    ...options,
  };
}

function passive(kind, build, summary) {
  return { actionable: false, kind, key: null, summary, build, evidence: null };
}

function ordered(builds) {
  return [...builds].sort((left, right) => (
    new Date(right.queueTime || 0).getTime() - new Date(left.queueTime || 0).getTime()
  ));
}

function ageMinutes(value, now) {
  return Math.max(0, (now.getTime() - new Date(value).getTime()) / 60_000);
}

function firstLine(value) {
  return String(value).split(/\r?\n/, 1)[0].slice(0, 240);
}

function stableKey(value) {
  return String(value).toLowerCase().replace(/https?:\/\/\S+/g, "url").replace(/[0-9a-f]{8,}/g, "id").replace(/\d+/g, "#").replace(/\W+/g, "-").slice(0, 100);
}

function flakyCapacitySignal(signals) {
  const summary = signals.find((signal) => /flaky test cap exceeded/i.test(signal));
  if (!summary) return null;
  const cap = summary.match(/cap is (\d+)/i)?.[1] || "unknown";
  const unskipped = summary.match(/(\d+) test\(s\) will NOT be skipped/i)?.[1] || "unknown";
  return { summary, key: `cap-${cap}-unskipped-${unskipped}` };
}
