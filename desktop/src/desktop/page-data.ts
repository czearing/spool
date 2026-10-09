import type { AgentJobs } from "../lib/agent-jobs";
import type { AgentPrompt } from "../lib/agents";
import type { readTaskBoard } from "../lib/board-archive";
import type { summarizeTasks } from "../lib/dashboard";
import type { Project } from "../lib/projects";
import type { TaskPreparation } from "../lib/task-preparation";

export type PageData = {
  projects: Project[];
  project?: Project;
  agents: string[];
  version: string;
  page: { kind: "setup" } | { kind: "dashboard"; initial: ReturnType<typeof summarizeTasks> }
    | { kind: "tasks"; board: Awaited<ReturnType<typeof readTaskBoard>>; preparations: TaskPreparation[] }
    | { kind: "agent"; agent: string; jobs: AgentJobs }
    | { kind: "prompt"; document: AgentPrompt }
    | { kind: "runners" } | { kind: "workflow"; runner: string };
};
