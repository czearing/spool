import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { applicationPaths } from "./application-paths";
import type { TaskSubmission } from "./task-submission";

export async function workspaceLaunch(root: string, draft: TaskSubmission, settings: unknown) {
  if (!settings || typeof settings !== "object") return;
  const declarations = Reflect.get(settings, "workspacePreparations");
  const providers = Reflect.get(settings, "copilotProviders");
  const provider = providers && typeof providers === "object" ? Reflect.get(providers, draft.agent) : undefined;
  const args: unknown = provider && typeof provider === "object" ? Reflect.get(provider, "args") : undefined;
  if (!(declarations && typeof declarations === "object" && draft.agent in declarations) &&
      !(Array.isArray(args) && args.includes("--config"))) return;
  const source: unknown = await import(/* @vite-ignore */ pathToFileURL(
    join(applicationPaths().resources, "runners", "bridge", "workspace-readiness.mjs"),
  ).href);
  if (!source || typeof source !== "object" || !("taskWorkspaceRequirement" in source) ||
      typeof source.taskWorkspaceRequirement !== "function" || !("stageWorkspaceTask" in source) ||
      typeof source.stageWorkspaceTask !== "function")
    throw new Error("The runner installation does not support workspace launch preparation.");
  if (!source.taskWorkspaceRequirement(root, draft.agent, draft.prompt)) return;
  const stageWorkspaceTask = source.stageWorkspaceTask;
  return { submit: () => stageWorkspaceTask(root, draft) as Promise<void> };
}
