import { memo, useCallback, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { NavigationSnapshot } from "../platform/navigation";
import { ProjectLiveProvider } from "../components/project-live-provider";
import { RunnerLiveProvider } from "../components/runner-live-provider";
import { NavigationGuard } from "../components/navigation-guard";
import { AppShell } from "../components/app-shell";
import { PageContent } from "./page";
import type { PageData } from "./page-data";
import { ContentPlaceholder } from "../components/ui/content-placeholder";

export const ProjectView = memo(function ProjectView({ data, active, status, pending = false }: {
  data: PageData; active: boolean; status?: ReactNode; pending?: boolean;
}) {
  const project = data.project!.id, client = useQueryClient();
  const runnersEnabled = data.flights?.runners === true;
  const refresh = useCallback(() => { void client.invalidateQueries({ queryKey: ["desktop-page", encodeURIComponent(project)] }); }, [client, project]);
  const content = <NavigationGuard>
    <AppShell project={project} agents={data.agents} runnersEnabled={runnersEnabled}
      options={data.projects.map(({ id, name }) => ({ value: id, label: name }))}>
      {status}
      {pending ? <ContentPlaceholder label="Page" /> : <PageContent data={data} />}
    </AppShell>
  </NavigationGuard>;
  return <NavigationSnapshot refresh={refresh} active={active}>
    <ProjectLiveProvider project={project}>
      {runnersEnabled
        ? <RunnerLiveProvider project={project} initial={data.runners}>{content}</RunnerLiveProvider>
        : content}
    </ProjectLiveProvider>
  </NavigationSnapshot>;
});
