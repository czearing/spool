import { useQuery } from "@tanstack/react-query";
import { useProjectLive } from "../components/project-live-provider";
import type { AgentJobs } from "../lib/agent-jobs";

export function useAgentJobs(project: string, agent: string, initialData?: AgentJobs) {
  const { error, retry } = useProjectLive();
  const { data } = useQuery<AgentJobs>({ queryKey: ["agent-jobs", project, agent], initialData, enabled: false });
  return { data, error, refetch: retry };
}
