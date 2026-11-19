export function operationError(error, operation) {
  const message = error.message || String(error);
  const rules = [
    [/connector.*absolute local path|Missing runner module|ERR_MODULE_NOT_FOUND/,
      "runtime_incomplete", "runtime", "Repair the complete MCP runtime bundle; do not change source or retry publication through another API."],
    [/ENOENT:[^\r\n]*queues[\\/]+in_progress[\\/]+[^'"\r\n]+\.json/,
      "task_context", "context", "The original task must be in progress before publication. Have the runner reopen it through supported status controls, preserve its commit and session, and retry repository MCP. Do not mark work failed or completed before publication finishes."],
    [/Codespace engineering preparation is not ready/,
      "preparation_required", "preparation", "Restore readiness with repo_prepare on the original owned checkout using mode resume and reset false, then repeat this MCP operation. Preserve saved work and use only repository MCP for publication."],
    [/GITHUB_RATE_LIMITED|(?:GitHub|API).{0,80}(?:rate limit|cooldown)/i,
      "GITHUB_RATE_LIMITED", "transport", "Wait for the shared GitHub cooldown to expire, then resume this original task and retry through repository MCP. Do not start alternate connections or publishers."],
    [/PR description rejected|Invalid PR|Invalid (?:category|title|problem|solution|validation|uiChange)|Unsupported 1JS operation field/,
      "invalid_input", "input", "Correct the listed fields and repeat this MCP call; no alternate publisher is needed."],
    [/staged, unstaged or untracked changes/,
      "dirty_checkout", "checkout", "Commit the intended changes and keep unrelated files outside the checkout, then repeat publication. Do not discard work."],
    [/VS403660|permission to create ref/,
      "branch_permission", "push", "Use repository preparation to select an authorized branch namespace, then publish that branch; do not bypass permissions."],
    [/canonical result and runner configuration|task-bound.*context|Review resolution does not belong/,
      "task_context", "context", "Have the runner refresh the original task's handoff artifacts; do not invent paths or edit ownership receipts."],
    [/workspace.*busy|another operation owns|another workspace/i,
      "workspace_busy", "ownership", "Wait for the current owner to finish and retry on your assigned workspace; do not stop agents or clear locks."],
    [/earlier PR creation intent|reconcile|interrupted|timed? ?out|deadline|ECONN|SSH|shell closed/,
      "operation_interrupted", "transport", "Inspect the recorded operation and branch PR before retrying. If a PR exists, update it; do not create a duplicate."],
    [/Required .+ failed|pre-push|packageJsonPath|missing dependency|Cannot find module|Native Codespace .+ failed/,
      "validation_failed", "validation", "Read the retained command log, fix the failing dependency or check, and rerun the same MCP operation. Keep hooks and checks enabled."],
  ];
  const rule = rules.find(([pattern]) => pattern.test(message));
  return {
    code: error.code || rule?.[1] || "repository_operation_failed",
    operation,
    stage: error.stage || rule?.[2] || operation || "request",
    ...(error.reasonCode ? { reasonCode: error.reasonCode } : {}),
    ...(error.retryAt ? { retryAt: error.retryAt } : {}),
    nextAction: error.nextAction || rule?.[3] ||
      "Fix the reported cause and repeat this MCP operation. If publication may have started, reconcile the branch PR first.",
  };
}

export function failureResult(error, operation) {
  if (error.code === "review_superseded" && error.reviewOutcome?.status === "superseded") {
    return { isError: false, content: [{ type: "text", text: `${error.message}\nNext: ${error.nextAction}` }],
      structuredContent: { ready: false, status: "superseded", reviewOutcome: error.reviewOutcome,
        operationError: operationError(error, operation) } };
  }
  const detail = operationError(error, operation);
  return { isError: true, content: [{ type: "text",
    text: `${error.message || String(error)}\nNext: ${detail.nextAction}` }],
    structuredContent: { operationError: detail, ...(error.publication ? { publication: error.publication } : {}) } };
}
