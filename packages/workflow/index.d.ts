export type RepositoryOperation = "refresh" | "setup" | "build" | "check" | "prepare-event" | "publish-fixes";
export type Operation = RepositoryOperation | "dispatch-event" | "resume-event" | "review-requested" | "build-incident" | "update-requested" | "report-ready" | "performance-capacity";
export type StepKind = "schedule" | "file-change" | "repository" | "agent" | "command" | "runner" | "manual" | "webhook" | "http" | "data" | "filter" | "azure-devops" | "repository-event";
export type FieldKey = "path" | "command" | "agent" | "prompt" | "secretEnv" | "url" | "method" | "body" | "bearerEnv" | "field" | "operator" | "compare" |
  "reviewer" | "maxAgeDays" | "revisionSettleSeconds" | "maxBuilds" | "stuckMinutes" | "persistentFailureMinutes" | "alertCooldownHours" | "quietMinutes" | "retryMinutes" | "maxOpenPrs";
export type WorkflowStep = {
  id: string; kind: StepKind; label: string; block?: string; operation?: Operation; position: { x: number; y: number };
} & Partial<Record<FieldKey, string>>;
export type WorkflowConnection = { id: string; source: string; target: string };
export type RunnerWorkflow = {
  id: string; name: string; kind: "custom" | "managed"; enabled: boolean; workspace: string;
  intervalSeconds: number; revision: string; nodes: WorkflowStep[]; edges: WorkflowConnection[];
  inspection?: Record<string, { context: Record<string, unknown>; prompt?: string; agentInstructions?: string; agentSource?: string; error?: string }>;
};
export type BlockField = {
  key: FieldKey; label: string; type: "text" | "textarea" | "file" | "env" | "select" | "agent" | "json" | "number";
  description?: string; options?: string[]; min?: number; max?: number; defaultValue?: string;
};
export type NodeChoice = {
  id: string; kind: Exclude<StepKind, "runner">; operation?: Operation; group: string;
  label: string; description: string; icon: string; fields: BlockField[];
};
export const nodeCatalog: readonly NodeChoice[];
export const repositoryOperations: readonly RepositoryOperation[];
export const integrationNodes: readonly NodeChoice[];
export const integrationNames: Partial<Record<StepKind, string>>;
export const eventSources: Partial<Record<Operation, string>>;
export function eventSource(workflow: RunnerWorkflow): string | undefined;
export function operationAvailable(node: NodeChoice, source?: string): boolean;
export function eventRecipe(id: string, values?: Record<string, unknown>, layout?: WorkflowStep[]): Pick<RunnerWorkflow, "nodes" | "edges">;
export const managedIds: readonly string[];
export function isTrigger(step: WorkflowStep): boolean;
export function stepDefinition(step: WorkflowStep): NodeChoice | undefined;
export function stepError(step: WorkflowStep): string | undefined;
export function validId(id: unknown): id is string;
export function validateWorkflow(value: unknown): WorkflowStep[];
export function executionSettings(value: RunnerWorkflow): unknown[];
