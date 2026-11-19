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
  const refresh = useCallback(() => { void client.invalidateQueries({ queryKey: ["desktop-page", encodeURIComponent(project)] }); }, [client, project]);
  return <NavigationSnapshot refresh={refresh} active={active}>
    <ProjectLiveProvider project={project}>
      <RunnerLiveProvider project={project} initial={data.runners}>
        <NavigationGuard>
          <AppShell project={project} agents={data.agents}
            options={data.projects.map(({ id, name }) => ({ value: id, label: name }))}>
            {status}
            {pending ? <ContentPlaceholder label="Page" /> : <PageContent data={data} />}
          </AppShell>
        </NavigationGuard>
      </RunnerLiveProvider>
    </ProjectLiveProvider>
  </NavigationSnapshot>;
});
