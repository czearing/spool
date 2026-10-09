import dynamic from "../platform/lazy";
import { LiveQueueRefresh } from "../components/live-queue-refresh";
import type { PageData } from "./page-data";

const Dashboard = dynamic(() => import("../components/dashboard").then(module => module.Dashboard));
const ProjectBoard = dynamic(() => import("../components/project-board").then(module => module.ProjectBoard));
const AgentConversations = dynamic(() => import("../components/agent-conversations").then(module => module.AgentConversations));
const AgentPromptEditor = dynamic(() => import("../components/agent-prompt-editor").then(module => module.AgentPromptEditor));
const RunnersPage = dynamic(() => import("../components/runners-page").then(module => module.RunnersPage));
const RunnerWorkflowPage = dynamic(() => import("../components/runner-workflow-page").then(module => module.RunnerWorkflowPage));

export function PageContent({ data }: { data: PageData }) {
  const project = data.project!.id, page = data.page;
  switch (page.kind) {
    case "dashboard": return <Dashboard project={project} initial={page.initial} version={data.version} />;
    case "tasks": return <><LiveQueueRefresh initialVersion={data.version} />
      <ProjectBoard project={project} items={page.board.items} archived={page.board.archived}
        agents={data.agents} preparations={page.preparations} /></>;
    case "agent": return <><LiveQueueRefresh initialVersion={data.version} />
      <AgentConversations key={`${project}:${page.agent}`} project={project} agent={page.agent} jobs={page.jobs} /></>;
    case "prompt": return <AgentPromptEditor key={`${project}:${page.document.id}`} project={project} document={page.document} />;
    case "runners": return <RunnersPage project={project} />;
    case "workflow": return <RunnerWorkflowPage project={project} id={page.runner} />;
    default: return null;
  }
}
