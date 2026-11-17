import { Activity, useCallback, useEffect, useState } from "react";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { NavigationProvider, navigate, usePathname } from "../platform/navigation";
import { ProjectSetup } from "../components/project-setup";
import { Text } from "../components/ui/text";
import { Button } from "../components/ui/button";
import { Stack } from "../components/ui/stack";
import { ProjectView } from "./project-view";
import { preloadAgentPage } from "./preload-agent-page";
import type { PageData } from "./page-data";
import { resumeConversationOutboxes } from "../lib/conversation-outbox";
import { desktopPageQuery, prefetchDestination } from "./page-query";
import { ContentPlaceholder } from "../components/ui/content-placeholder";

const retainedProjects = 3;

export function DesktopApp() {
  const [client] = useState(() => new QueryClient());
  return <QueryClientProvider client={client}><DesktopPages /></QueryClientProvider>;
}

function DesktopPages() {
  useEffect(resumeConversationOutboxes, []);
  const pathname = usePathname(), client = useQueryClient();
  const [recent, setRecent] = useState<PageData[]>([]);
  const project = pathname.split("/")[1] || "";
  const refresh = useCallback(() => { void client.invalidateQueries({ queryKey: ["desktop-page", project] }); }, [client, project]);
  const query = useQuery(desktopPageQuery(pathname));
  const prefetch = useCallback((href: string) => {
    if (window.location.hash.slice(1) !== href) void prefetchDestination(client, href).catch(console.error);
  }, [client]);
  const current = query.data && !("redirect" in query.data) ? query.data : undefined;
  useEffect(() => {
    if (/^\/[^/]+\/agents\/[^/]+$/.test(pathname)) void preloadAgentPage().catch(console.error);
  }, [pathname]);
  useEffect(() => {
    if (query.data && "redirect" in query.data) navigate(query.data.redirect, true);
    if (current) {
      setRecent(saved => [...saved.filter(page => page.project?.id !== current.project?.id), current].slice(-retainedProjects));
    }
  }, [query.data, current]);
  const shell = current ?? recent.find(page => page.project && encodeURIComponent(page.project.id) === project) ?? recent.at(-1);
  const agent = shell?.project && shell.agents.find(id =>
    pathname === `/${encodeURIComponent(shell.project!.id)}/agents/${encodeURIComponent(id)}`);
  const data = current ?? (agent ? { ...shell!, page: { kind: "agent" as const, agent } } : undefined);
  const error = query.error?.message;
  const status = error ? <Stack gap={4} style={{ padding: 24 }}>
    <Text role="alert">{error}</Text><Button onClick={refresh}>Retry</Button>
  </Stack> : undefined;
  const views = shell?.project ? [...recent.filter(page => page.project && page.project.id !== shell.project!.id &&
    shell.projects.some(project => project.id === page.project!.id)), data ?? shell].slice(-retainedProjects) : [];
  return <NavigationProvider refresh={refresh} prefetch={prefetch}>
    {!shell ? status ?? <ContentPlaceholder label="Page" /> : shell.project
      ? views.map(view => <Activity key={view.project!.id} mode={view.project!.id === shell.project!.id ? "visible" : "hidden"}>
        <ProjectView data={view} active={encodeURIComponent(view.project!.id) === project}
          pending={view.project!.id === shell.project!.id && !data}
          status={view.project!.id === shell.project!.id ? status : undefined} />
      </Activity>) : <ProjectSetup />}
  </NavigationProvider>;
}
