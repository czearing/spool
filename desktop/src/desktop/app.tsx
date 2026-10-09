import { useCallback, useEffect, useState } from "react";
import { appFetch } from "../platform/request";
import { NavigationProvider, navigate, usePathname } from "../platform/navigation";
import { ProjectLiveProvider } from "../components/project-live-provider";
import { RunnerLiveProvider } from "../components/runner-live-provider";
import { NavigationGuard } from "../components/navigation-guard";
import { AppShell } from "../components/app-shell";
import { ProjectSetup } from "../components/project-setup";
import { Text } from "../components/ui/text";
import { Button } from "../components/ui/button";
import { Stack } from "../components/ui/stack";
import { PageContent } from "./page";
import type { PageData } from "./page-data";

export function DesktopApp() {
  const pathname = usePathname(), [revision, setRevision] = useState(0);
  const [snapshot, setSnapshot] = useState<{ path: string; data: PageData }>();
  const [error, setError] = useState<string>();
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    void appFetch(`/api/desktop/page?path=${encodeURIComponent(pathname)}`, { signal: controller.signal })
      .then(async response => {
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Could not load this page.");
        if (controller.signal.aborted) return;
        if (result.redirect) { navigate(result.redirect, true); return; }
        setSnapshot({ path: pathname, data: result }); setError(undefined);
      }).catch(error => { if (!controller.signal.aborted) setError(String(error.message || error)); });
    return () => controller.abort();
  }, [pathname, revision]);
  const data = snapshot?.data;
  const loading = snapshot?.path !== pathname;
  const status = <Stack gap={4} style={{ padding: 24 }}>
    <Text role={error ? "alert" : "status"}>{error || "Loading Spool..."}</Text>
    {error && <Button onClick={refresh}>Retry</Button>}
  </Stack>;
  return <NavigationProvider refresh={refresh}>
    {!data ? status : data.project
      ? <ProjectLiveProvider key={data.project.id} project={data.project.id}>
        <RunnerLiveProvider project={data.project.id}><NavigationGuard>
          <AppShell project={data.project.id} agents={data.agents}
            options={data.projects.map(({ id, name }) => ({ value: id, label: name }))}>
            {error || loading ? status : <PageContent data={data} />}
          </AppShell>
        </NavigationGuard></RunnerLiveProvider>
      </ProjectLiveProvider> : <ProjectSetup />}
  </NavigationProvider>;
}
