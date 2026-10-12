"use client";

import { usePathname } from "../platform/navigation";
import { Plus, Server } from "lucide-react";
import type { RunnerCatalog } from "../lib/runner-catalog";
import { SidebarAccordion, SidebarAction, SidebarItem } from "./ui/sidebar";
import { Button } from "./ui/button";
import { Stack } from "./ui/stack";
import { Text } from "./ui/text";
import { NavigationLink } from "./navigation-link";
import { useNavigationGuard } from "./navigation-guard";
import { useRunnerLive } from "./runner-live-provider";
import styles from "./app-shell.module.css";

export function RunnerSidebarItems({ project, pathname, data, error, onRetry }: {
  project: string; pathname: string; data?: RunnerCatalog; error?: string; onRetry: () => void;
}) {
  const base = `/${project}/runners`;
  const { navigate } = useNavigationGuard();
  return <>
    {data?.runners.map(runner => <SidebarItem key={runner.id} href={`${base}/${encodeURIComponent(runner.id)}`}
      linkComponent={NavigationLink} icon={<Server />} active={pathname === `${base}/${runner.id}`} title={runner.name || runner.id}>
      {runner.name || runner.id}
    </SidebarItem>)}
    {error ? <li className={styles.emptyAgents}><Stack gap={2}>
      <Text variant="meta" role="alert">{error}</Text>
      <Button onClick={onRetry}>Retry runner list</Button>
    </Stack></li> : null}
    <SidebarAction icon={<Plus />} disabled={!data?.configured || !!error} onClick={() => navigate(`${base}/new`)}>
      Add runner
    </SidebarAction>
  </>;
}
export function RunnerSidebar({ project }: { project: string }) {
  const pathname = usePathname(), query = useRunnerLive();
  const editing = pathname === `/${project}/runners` || pathname.startsWith(`/${project}/runners/`);
  return <SidebarAccordion key={`${project}:${editing}`} label="Runners" defaultOpen={editing}>
    <RunnerSidebarItems project={project} pathname={pathname} data={query.data}
      error={query.error?.message} onRetry={query.refetch} />
  </SidebarAccordion>;
}
