"use client";

import { Server } from "lucide-react";
import { usePathname } from "../platform/navigation";
import { SidebarAccordion, SidebarItem } from "./ui/sidebar";
import { NavigationLink } from "./navigation-link";
import { useRunnerLive } from "./runner-live-provider";
import { Text } from "./ui/text";
import { Button } from "./ui/button";
import { Stack } from "./ui/stack";
import { ActiveInstances } from "./active-instances";
import styles from "./app-shell.module.css";

export function RunnerSidebar({ project }: { project: string }) {
  const pathname = usePathname(), query = useRunnerLive(), base = `/${project}/runners`;
  const error = query.error || query.status.error;
  const running = new Set(error ? [] : query.status.data?.runners.filter(runner => runner.running).map(runner => runner.id));
  const total = query.data?.runners.filter(runner => running.has(runner.id)).length || 0;
  const selected = pathname.startsWith(`${base}/`);
  return <SidebarAccordion key={`${project}:${selected}`} label="Runners" defaultOpen={selected}
    badge={<ActiveInstances count={total} name="Runners" />}>
    {query.data?.runners.map(runner => <SidebarItem key={runner.id} href={`${base}/${encodeURIComponent(runner.id)}`}
      linkComponent={NavigationLink} icon={<Server />} active={pathname === `${base}/${runner.id}`} title={runner.name || runner.id}
      badge={running.has(runner.id) ? <ActiveInstances count={1} name={runner.name || runner.id} /> : undefined}>
      {runner.name || runner.id}
    </SidebarItem>)}
    {error && <li className={styles.emptyAgents}><Stack gap={2}>
      <Text variant="meta" role="alert">{error.message}</Text>
      <Button onClick={() => { query.refetch(); void query.status.refetch(); }}>Retry runner list</Button>
    </Stack></li>}
    {!error && !query.data?.runners.length && <li className={styles.emptyAgents}>
      <Text variant="meta" tone="muted">No runners configured.</Text>
    </li>}
  </SidebarAccordion>;
}
