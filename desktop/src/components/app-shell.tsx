"use client";

import { usePathname } from "../platform/navigation";
import { useRef, useState, useTransition, type ReactNode } from "react";
import { Home, ListTodo, PanelLeft, Settings, Plus } from "lucide-react";
import dynamic from "../platform/lazy";
import { AgentAvatar } from "./agent-avatar";
import { Sidebar, SidebarAccordion, SidebarAction, SidebarGroup, SidebarItem, type SidebarOption } from "./ui/sidebar";
import { SettingsDialog } from "./settings-dialog";
import { Stack } from "./ui/stack";
import { useNavigationGuard } from "./navigation-guard";
import { NavigationLink } from "./navigation-link";
import { useProjectLive } from "./project-live-provider";
import { ActiveInstances } from "./active-instances";
import { AgentActions } from "./agent-actions";
import { ProjectSwitcher } from "./project-switcher";
import { RunnerSidebar } from "./runner-sidebar";
import { Button } from "./ui/button";
import { Text } from "./ui/text";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import styles from "./app-shell.module.css";
const AgentCreateDialog = dynamic(() => import("./agent-create-dialog").then((module) => module.AgentCreateDialog));

export function AppShell({ project, options, agents, children }: {
  project: string; options: readonly SidebarOption[]; agents: readonly string[]; children: ReactNode;
}) {
  const pathname = usePathname(), { navigate } = useNavigationGuard();
  const live = useProjectLive();
  const configured = live.data?.agents ?? agents.map((id) => ({ id, active: 0, icon: "bot" }));
  const total = live.error ? 0 : configured.reduce((count, agent) => count + agent.active, 0);
  const [pending, startTransition] = useTransition();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const createTrigger = useRef<HTMLButtonElement>(null);
  const settingsTrigger = useRef<HTMLButtonElement>(null);
  const tasks = pathname.endsWith("/tasks");
  const runners = pathname === `/${project}/runners` || pathname.startsWith(`/${project}/runners/`);
  const selectProject = (id: string) => startTransition(() => navigate(`/${id}${tasks ? "/tasks" : runners ? "/runners" : ""}`));
  const sidebar = <Sidebar label="Project navigation" aria-busy={pending} header={
    <ProjectSwitcher value={project} options={options} disabled={pending} onValueChange={selectProject} onCreated={selectProject} />
  } footer={<SidebarGroup><SidebarAction icon={<Settings />} onClick={(event) => {
    settingsTrigger.current = event.currentTarget; setSettingsOpen(true);
  }}>Settings</SidebarAction></SidebarGroup>}>
    <SidebarGroup>
      <SidebarItem href={`/${project}`} linkComponent={NavigationLink} icon={<Home />} active={pathname === `/${project}`}>Home</SidebarItem>
      <SidebarItem href={`/${project}/tasks`} linkComponent={NavigationLink} icon={<ListTodo />} active={tasks}>Tasks</SidebarItem>
    </SidebarGroup>
    <RunnerSidebar project={project} />
    <SidebarAccordion key={project} label="Agents" badge={<ActiveInstances count={total} name="Agents" />}>
      {configured.map(({ id, active }) => <SidebarItem key={id} href={`/${project}/agents/${encodeURIComponent(id)}`}
        linkComponent={NavigationLink} icon={<AgentAvatar agent={id} />} active={pathname === `/${project}/agents/${id}` || pathname.startsWith(`/${project}/agents/${id}/`)} title={id}
        actions={<AgentActions project={project} agent={id} compact />}
        badge={!live.error && active > 0 ? <ActiveInstances count={active} name={id} /> : undefined}>{id}</SidebarItem>)}
      {!configured.length && <li className={styles.emptyAgents}>No agents configured</li>}
      <SidebarAction icon={<Plus />} onClick={(event) => { createTrigger.current = event.currentTarget; setCreateOpen(true); }}>Create agent</SidebarAction>
    </SidebarAccordion>
    {live.error && <Text role="alert" variant="meta" className={styles.emptyAgents}>Live activity unavailable</Text>}
  </Sidebar>;
  return <Stack direction="row" gap={0} className={styles.shell}>
    <div className={styles.desktop}>{sidebar}</div>
    <Stack gap={0} className={styles.content}>
      <div className={styles.mobile}><Popover key={pathname}>
        <PopoverTrigger asChild><Button aria-label="Open sidebar"><PanelLeft className={styles.icon} aria-hidden="true" /></Button></PopoverTrigger>
        <PopoverContent label="Project navigation" className={styles.navigation} align="start" density="compact"><div className={styles.mobilePanel}>{sidebar}</div></PopoverContent>
      </Popover></div>
      {children}
    </Stack>
    <SettingsDialog key={project} project={project} open={settingsOpen} onOpenChange={setSettingsOpen}
      onCloseAutoFocus={(event) => { event.preventDefault(); settingsTrigger.current?.focus(); }} />
    {createOpen && <AgentCreateDialog key={project} project={project} open onOpenChange={setCreateOpen}
      onCreated={(name) => navigate(`/${project}/agents/${encodeURIComponent(name)}`)}
      onCloseAutoFocus={(event) => { event.preventDefault(); createTrigger.current?.focus(); }} />}
  </Stack>;
}
