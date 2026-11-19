export type ReviewSupersession = {
  status: "superseded";
  prId: number;
  sourceCommit: string;
  replacementSourceCommit: string;
  targetCommit: string;
};
export function reviewSupersession(task: unknown, metadata?: unknown): ReviewSupersession | null;
export type ReviewRevisionUpdate = {
  status: "revision_changed";
  prId: number;
  previousSourceCommit: string;
  sourceCommit: string;
  previousTargetCommit: string;
  targetCommit: string;
  sourceChanged: boolean;
  targetChanged: boolean;
};
export function reviewRevisionUpdate(expected: {
  id: number | string; sourceCommit: string; targetCommit: string;
}, actual: {
  id: number | string; sourceCommit: string; targetCommit: string;
}): ReviewRevisionUpdate | null;
export function reviewRevisionUpdateMessage(update: ReviewRevisionUpdate): string;
export function reviewRevisionChange(expected: {
  id: number; sourceCommit: string; targetCommit?: string;
}, actual: {
  id: number; sourceCommit: string; targetCommit: string;
}): ReviewSupersession | null;
export function supersededReviewError(outcome: ReviewSupersession): Error & {
  code: "review_superseded"; stage: "revision"; reviewOutcome: ReviewSupersession; nextAction: string;
};
