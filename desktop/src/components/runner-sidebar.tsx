"use client";

import { usePathname } from "../platform/navigation";
import { Plus, Server } from "lucide-react";
import type { RunnerSnapshot } from "../lib/runners";
import { SidebarAccordion, SidebarItem } from "./ui/sidebar";
import { Button } from "./ui/button";
import { Stack } from "./ui/stack";
import { Text } from "./ui/text";
import { NavigationLink } from "./navigation-link";
import { useRunnerLive } from "./runner-live-provider";
import styles from "./app-shell.module.css";

export function RunnerSidebarItems({ project, pathname, data, loading, error, onRetry }: {
  project: string; pathname: string; data?: RunnerSnapshot; loading: boolean; error?: string; onRetry: () => void;
}) {
  const base = `/${project}/runners`;
  return <>
    <SidebarItem href={base} linkComponent={NavigationLink} icon={<Server />} active={pathname === base}>All runners</SidebarItem>
    {!error && data?.runners.map(runner => <SidebarItem key={runner.id} href={`${base}/${encodeURIComponent(runner.id)}`}
      linkComponent={NavigationLink} icon={<Server />} active={pathname === `${base}/${runner.id}`} title={runner.name || runner.id}>
      {runner.name || runner.id}
    </SidebarItem>)}
    {error ? <li className={styles.emptyAgents}><Stack gap={2}>
      <Text variant="meta" role="alert">Runner list unavailable</Text>
      <Button onClick={onRetry}>Retry runner list</Button>
    </Stack></li> : loading ? <li className={styles.emptyAgents}><Text variant="meta" role="status">Loading runners...</Text></li> :
      !data?.runners.length && <li className={styles.emptyAgents}>No runners configured</li>}
    {!error && data?.configured && <SidebarItem href={`${base}/new`} linkComponent={NavigationLink} icon={<Plus />} active={pathname === `${base}/new`}>
      Create runner
    </SidebarItem>}
  </>;
}
export function RunnerSidebar({ project }: { project: string }) {
  const pathname = usePathname(), query = useRunnerLive();
  const editing = pathname === `/${project}/runners` || pathname.startsWith(`/${project}/runners/`);
  return <SidebarAccordion key={`${project}:${editing}`} label="Runners" defaultOpen={editing}>
    <RunnerSidebarItems project={project} pathname={pathname} data={query.data} loading={query.isPending}
      error={query.error?.message} onRetry={query.refetch} />
  </SidebarAccordion>;
}
