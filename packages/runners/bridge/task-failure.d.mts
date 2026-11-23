type FailureTask = { id?: unknown; status?: unknown; error?: unknown; updated_at?: unknown; failure_origin?: unknown };
export function agentReportedFailure(root: string | undefined, task: FailureTask): boolean;
export function taskFailurePresentation(root: string | undefined, task: FailureTask):
  { status?: "blocked"; queueStatus?: "failed"; error?: null };
export function settleFailureBackfill(): Promise<void>;
export function backfillTaskFailures(root: string, tasks: FailureTask[]): Promise<void>;
export function failureOriginDirectory(root: string): string;
