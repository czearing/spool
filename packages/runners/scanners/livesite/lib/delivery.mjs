import { createHash } from "node:crypto";
import { HANDOFF_TRANSITIONS, setupAgentBranch, assertAgentWorkspaceIdle, slugifyBranchTopic } from "../../../packages/bohemia-agent-tooling/src/index.js";
import { assignmentPrompt } from "./detect.mjs";
import { createQueue } from "./queue.mjs";

export function submissionId(config, assessment, attempt = 1) {
  if (typeof assessment.key !== "string" || !assessment.key.trim()) throw new Error("Incident evidence key is required");
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error("Incident attempt must be a positive integer");
  const identity = JSON.stringify([config.organization || "", config.project || config.projectId || "", assessment.key]);
  return `livesite:${createHash("sha256").update(identity).digest("hex")}:${attempt}`;
}

export function incidentBranch(config, assessment, attempt = 1) {
  const id = submissionId(config, assessment, attempt);
  const hash = id.split(":")[1].slice(0, 8);
  let summary = assessment.summary || assessment.kind || "incident";
  if (summary.includes("->")) {
    summary = summary.split("->").pop().trim();
  }
  summary = summary
    .replace(/^Repeated in builds [^:]+:\s*/i, "")
    .replace(/^FlakyTestAssassin reported:\s*/i, "")
    .replace(/^FlakyTestAssassin capacity exceeded:\s*/i, "")
    .trim();

  const slug = slugifyBranchTopic(summary);
  const attemptSuffix = attempt > 1 ? `-${attempt}` : "";
  const suffix = `-${hash}${attemptSuffix}`;
  const maxSlugLength = 50 - "livesite-".length - suffix.length;
  const truncatedSlug = (slug || "incident").slice(0, Math.max(1, maxSlugLength)).replace(/-+$/, "");
  return `livesite-${truncatedSlug}${suffix}`;
}

export function taskTitle(assessment, titleBudget = 80) {
  const raw = `[Livesite] ${assessment.kind}: ${assessment.summary}`;
  if (raw.length <= titleBudget) return raw;
  return `${raw.slice(0, titleBudget - 1)}…`;
}
export function incidentPrompt(assessment, branchName, repoRoot) {
  const promptLines = [assignmentPrompt(assessment)];
  if (branchName) {
    const repoText = repoRoot ? ` in \`${repoRoot}\`` : "";
    promptLines.push("", `The branch \`${branchName}\` is checked out${repoText} and verified clean. The workspace and dependencies are already set up for you. Do not run git checkout, fetch, reset, or clean; proceed directly to investigating the incident.`);
  }
  return promptLines.join("\n");
}

export async function assignIncident(config, assessment, attempt = 1, options = {}) {
  if (assessment.actionable === false) throw new Error("Non-actionable monitor failures cannot dispatch incident repairs");
  const queue = options.queue || createQueue(config);
  const ledger = options.ledger || null;
  const taskKey = submissionId(config, assessment, attempt);
  const title = taskTitle(assessment);
  const maxOpenTasks = config.maxOpenTasks ?? 1;

  if (queue.listIssues) {
    try {
      const active = await queue.listIssues({ assigneeAgentId: config.agentId });
      const inFlight = active.filter((i) => (!i.assigneeAgentId || i.assigneeAgentId === config.agentId) && ["todo", "in_progress", "in_review", "blocked"].includes(i.status));
      if (inFlight.length >= (config.repoRoot ? 1 : maxOpenTasks)) {
        ledger?.append(HANDOFF_TRANSITIONS.HELD, {
          taskKey,
          agent: config.agentName || config.agentId,
          title,
          detail: `Holding dispatch: agent already has ${inFlight.length} active incident(s) in flight (max ${maxOpenTasks})`,
        });
        return null;
      }
    } catch (error) {
      throw new Error(`Cannot verify livesite workspace ownership: ${error.message}`);
    }
  }

  const previous = await queue.findSubmission?.(taskKey);
  if (previous) return previous;

  // A replay must not recreate a branch that already contains the submitted repair.
  let branchName = null;
  if (config.repoRoot) {
    try {
      await assertAgentWorkspaceIdle(queue, config.agentId);
      const branchTopic = incidentBranch(config, assessment, attempt);
      const branchResult = await (options.setupAgentBranch || setupAgentBranch)({
        repoRoot: config.repoRoot,
        branch: branchTopic,
        baseBranch: "master",
        runSetup: true,
        runBuild: false,
      });
      branchName = branchResult.branch;
      await assertAgentWorkspaceIdle(queue, config.agentId);
    } catch (error) {
      if (error.code === "WORKFLOW_FILTERED") throw error;
      ledger?.append(HANDOFF_TRANSITIONS.REFUSED, { taskKey, agent: config.agentName || config.agentId, title, detail: `Workspace preparation failed: ${error.message}` });
      throw error;
    }
  }

  const description = incidentPrompt(assessment, branchName, config.repoRoot);

  try {
    const issue = await queue.createIssue({
      submissionId: taskKey,
      title,
      description,
      assigneeAgentId: config.agentId,
      projectId: config.projectId,
      priority: config.priority || "high",
      status: "todo",
    });
    ledger?.append(HANDOFF_TRANSITIONS.HANDED, {
      taskKey,
      agent: config.agentName || config.agentId,
      issueId: issue?.id || null,
      identifier: issue?.identifier || null,
      title,
      detail: assessment.summary,
    });
    return issue;
  } catch (error) {
    ledger?.append(HANDOFF_TRANSITIONS.REFUSED, {
      taskKey,
      agent: config.agentName || config.agentId,
      title,
      detail: error.message,
    });
    throw error;
  }
}
