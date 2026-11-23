export const preparationLabels = {
  waiting: "Waiting for runner", preparing: "Preparing workspace", submitted: "Creating task", failed: "Preparation failed",
} as const;
export type TaskPreparation = { id: string; title: string; agent: string; stage: keyof typeof preparationLabels; error?: string };
export function isTaskPreparation(value: unknown): value is TaskPreparation {
  return !!value && typeof value === "object" && "id" in value && typeof value.id === "string" &&
    "title" in value && typeof value.title === "string" && "agent" in value && typeof value.agent === "string" &&
    "stage" in value && typeof value.stage === "string" && Object.hasOwn(preparationLabels, value.stage) &&
    (!("error" in value) || typeof value.error === "string");
}
