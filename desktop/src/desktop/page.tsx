import { Activity, useEffect, useState } from "react";
import dynamic from "../platform/lazy";
import { NavigationSnapshot, useRouter } from "../platform/navigation";
import { LiveQueueRefresh } from "../components/live-queue-refresh";
import { AgentConversations } from "../components/agent-conversations";
import type { PageData } from "./page-data";

const Dashboard = dynamic(() => import("../components/dashboard").then(module => module.Dashboard));
const ProjectBoard = dynamic(() => import("../components/project-board").then(module => module.ProjectBoard));
const AgentPromptEditor = dynamic(() => import("../components/agent-prompt-editor").then(module => module.AgentPromptEditor));
const RunnerPage = dynamic(() => import("../components/runner-overview").then(module => module.RunnerPage));
const retainedAgents = 3;

export function PageContent({ data }: { data: PageData }) {
  const project = data.project!.id, page = data.page;
  const { refresh } = useRouter();
  const [recent, setRecent] = useState<PageData[]>([]);
  const agent = page.kind === "agent" ? page.agent : undefined;
  const current = page.kind === "agent" ? data : undefined;
  useEffect(() => {
    if (current) setRecent(saved => [...saved.filter(view => view.page.kind !== "agent" ||
      view.page.agent !== agent), current].slice(-retainedAgents));
  }, [current, agent]);
  const views = [...recent.filter(view => view.page.kind === "agent" && view.page.agent !== agent &&
    data.agents.includes(view.page.agent)), ...(current ? [current] : [])].slice(-retainedAgents);
  let content;
  switch (page.kind) {
    case "dashboard": content = <Dashboard project={project} initial={page.initial} version={data.version} />; break;
    case "tasks": content = <><LiveQueueRefresh initialVersion={data.version} />
      <ProjectBoard project={project} items={page.board.items} archived={page.board.archived}
        agents={data.agents} /></>; break;
    case "prompt": content = <AgentPromptEditor key={`${project}:${page.document.id}:${page.document.scope ?? "prompt"}`} project={project} document={page.document} />; break;
    case "runner": content = <RunnerPage key={`${project}:${page.runner.id}`} project={project} runner={page.runner} />; break;
  }
  return <>{views.map(view => view.page.kind === "agent" && <NavigationSnapshot key={view.page.agent}
    active={page.kind === "agent" && page.agent === view.page.agent} refresh={refresh}>
    <Activity mode={page.kind === "agent" && page.agent === view.page.agent ? "visible" : "hidden"}>
      <AgentConversations project={project} agent={view.page.agent} jobs={view.page.jobs} />
    </Activity>
  </NavigationSnapshot>)}{content}</>;
}
