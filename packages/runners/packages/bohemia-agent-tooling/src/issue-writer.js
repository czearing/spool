/**
 * Issue writer. Two of the four channels leave the tool here: the task out issue and the defect issue.
 * Both bodies are held under a character budget because the local adapter passes a description on the
 * command line, and a long description fails the wake.
 */

export const DEFAULT_BODY_BUDGET = 900;
export const DEFAULT_TITLE_BUDGET = 120;

function formatNumber(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(3);
}

/**
 * The default task rendering. A tool whose task says more than one number, a set of files for
 * instance, supplies its own renderTask instead. What a task is allowed to leave out is not
 * negotiable either way: the numbers below are checked before any rendering runs, so a task without a
 * current number cannot be written by any renderer.
 */
export function renderNumericTask(candidate, options = {}) {
  const repoRoot = options.repoRoot || candidate.repoRoot || null;
  const branchName = candidate.branchName || null;
  const title = `perf: ${candidate.metric} ${formatNumber(candidate.current)} to ${formatNumber(candidate.target)} ${candidate.unit}`;
  const lines = [
    `metric: ${candidate.metric}`,
    `current: ${formatNumber(candidate.current)} ${candidate.unit}`,
    `target: ${formatNumber(candidate.target)} ${candidate.unit}`,
    `acceptance: ${candidate.metric} at or below ${formatNumber(candidate.acceptance)} ${candidate.unit}`,
  ];

  if (branchName) {
    const repoText = repoRoot ? ` in \`${repoRoot}\`` : "";
    lines.push(
      "",
      `The branch \`${branchName}\` is checked out${repoText} and verified clean. The workspace and dependencies are already set up for you. Do not run git checkout, fetch, reset, or clean; proceed directly to your optimizations.`,
      "",
    );
  }

  lines.push(
    `reproduction: ${candidate.reproduction}`,
    "",
    "Close this issue when the acceptance number is met and record the measured result as a line",
    "after: <number>",
  );
  return { title, body: lines.join("\n") };
}

export function buildTaskIssue(
  candidate,
  { bodyBudget = DEFAULT_BODY_BUDGET, titleBudget = DEFAULT_TITLE_BUDGET, renderTask = renderNumericTask } = {},
) {
  if (typeof renderTask !== "function") {
    throw new Error("renderTask must be a function returning a title and a body");
  }
  for (const key of ["current", "target", "acceptance"]) {
    if (typeof candidate?.[key] !== "number" || !Number.isFinite(candidate[key])) {
      throw new Error(`refusing to write a task without a finite ${key} number`);
    }
  }
  for (const key of ["metric", "unit", "reproduction"]) {
    if (typeof candidate?.[key] !== "string" || candidate[key].trim() === "") {
      throw new Error(`refusing to write a task without ${key}`);
    }
  }

  const { title, body } = renderTask(candidate);
  if (typeof title !== "string" || title.trim() === "" || typeof body !== "string" || body.trim() === "") {
    throw new Error("renderTask must return a non empty title and body");
  }

  if (title.length > titleBudget) {
    throw new Error(`task title is ${title.length} characters, budget is ${titleBudget}`);
  }
  if (body.length > bodyBudget) {
    throw new Error(`task body is ${body.length} characters, budget is ${bodyBudget}`);
  }

  return { title, body };
}

export function buildDefectIssue(defect, { bodyBudget = DEFAULT_BODY_BUDGET, titleBudget = DEFAULT_TITLE_BUDGET } = {}) {
  if (typeof defect?.summary !== "string" || defect.summary.trim() === "") {
    throw new Error("refusing to write a defect without a summary");
  }
  const title = `defect: ${defect.summary}`.slice(0, titleBudget);
  const body = [
    `tool: ${defect.tool ?? "unknown"}`,
    `surface: ${defect.surface ?? "unknown"}`,
    `summary: ${defect.summary}`,
    defect.detailPath ? `detail: ${defect.detailPath}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  if (body.length > bodyBudget) {
    throw new Error(`defect body is ${body.length} characters, budget is ${bodyBudget}`);
  }
  return { title, body };
}

export async function writeTaskIssue({ queue, candidate, assigneeAgentId, parentIssueId, projectId, bodyBudget, titleBudget, renderTask }) {
  if (!queue || typeof queue.createIssue !== "function") {
    throw new Error("issue writer requires a queue with createIssue");
  }
  if (typeof assigneeAgentId !== "string" || assigneeAgentId.trim() === "") {
    throw new Error("issue writer requires an assignee agent id");
  }
  const { title, body } = buildTaskIssue(candidate, { bodyBudget, titleBudget, renderTask });
  return queue.createIssue({
    title,
    description: body,
    assigneeAgentId,
    parentId: parentIssueId ?? undefined,
    projectId: projectId ?? undefined,
    priority: "medium",
  });
}

export async function writeDefectIssue({ queue, defect, ownerAgentId, parentIssueId, bodyBudget, titleBudget }) {
  if (!queue || typeof queue.createIssue !== "function") {
    throw new Error("issue writer requires a queue with createIssue");
  }
  if (typeof ownerAgentId !== "string" || ownerAgentId.trim() === "") {
    throw new Error("defect writer requires a tool owner agent id");
  }
  const { title, body } = buildDefectIssue(defect, { bodyBudget, titleBudget });
  return queue.createIssue({
    title,
    description: body,
    assigneeAgentId: ownerAgentId,
    parentId: parentIssueId ?? undefined,
    priority: "high",
  });
}
