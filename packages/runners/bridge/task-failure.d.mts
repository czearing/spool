type FailureTask = { id?: unknown; status?: unknown; error?: unknown };
export function agentReportedFailure(root: string | undefined, task: FailureTask): boolean;
export function taskFailurePresentation(root: string | undefined, task: FailureTask):
  { status?: "blocked"; queueStatus?: "failed"; error?: null };
