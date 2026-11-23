"use client";

import { usePathname } from "../platform/navigation";
import { memo, useRef, useState, useTransition, type MouseEventHandler, type ReactNode } from "react";
import { Home, ListTodo, PanelLeft, Settings, Plus } from "lucide-react";
import dynamic from "../platform/lazy";
import { AgentImage } from "./agent-avatar";
import { Sidebar, SidebarAccordion, SidebarAction, SidebarGroup, SidebarItem, type SidebarOption } from "./ui/sidebar";
import { Stack } from "./ui/stack";
import { useNavigationGuard } from "./navigation-guard";
import { NavigationLink } from "./navigation-link";
import { useProjectLive } from "./project-live-provider";
import { ActiveInstances } from "./active-instances";
import { AgentActions } from "./agent-actions";
import { RunnerSidebar } from "./runner-sidebar";
import { ProjectSwitcher } from "./project-switcher";
import { Button } from "./ui/button";
import { Text } from "./ui/text";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import styles from "./app-shell.module.css";
const AgentCreateDialog = dynamic(() => import("./agent-create-dialog").then((module) => module.AgentCreateDialog));
const SettingsDialog = dynamic(() => import("./settings-dialog").then((module) => module.SettingsDialog), {
  loading: () => <Text role="status">Loading settings...</Text>,
});

const AgentNavigationItem = memo(function AgentNavigationItem({ project, id, title = id, active, pending, starting, imageVersion, selected, unavailable }: {
  project: string; id: string; title?: string; active: number; pending?: number; starting?: number; imageVersion?: string | null;
  selected: boolean; unavailable: boolean;
}) {
  return <SidebarItem href={`/${project}/agents/${encodeURIComponent(id)}`}
    linkComponent={NavigationLink} icon={<AgentImage project={project} agent={id} version={imageVersion} />} active={selected} title={title}
    actions={<AgentActions project={project} agent={id} compact />}
    badge={!unavailable ? <ActiveInstances count={active} pending={pending} starting={starting} name={title} /> : undefined}>{title}</SidebarItem>;
});

function AgentNavigation({ project, agents, pathname, onCreate }: {
  project: string; agents: readonly string[]; pathname: string; onCreate: MouseEventHandler<HTMLButtonElement>;
}) {
  const live = useProjectLive();
  const configured = live.data?.agents ?? agents.map(id => ({ id, title: id, active: 0, pending: 0, starting: 0, imageVersion: null }));
  const total = live.error ? 0 : configured.reduce((count, agent) => count + agent.active, 0);
  const pendingTotal = live.error ? 0 : configured.reduce((count, agent) => count + (agent.pending ?? 0), 0);
  const startingTotal = live.error ? 0 : configured.reduce((count, agent) => count + (agent.starting ?? 0), 0);
  return <>
    <SidebarAccordion key={project} label="Agents" badge={<ActiveInstances count={total} pending={pendingTotal} starting={startingTotal} name="Agents" />}>
      {configured.map(({ id, title, active, pending, starting, imageVersion }) => <AgentNavigationItem key={id}
        project={project} id={id} title={title} active={active} pending={pending} starting={starting} imageVersion={imageVersion}
        selected={pathname === `/${project}/agents/${id}` || pathname.startsWith(`/${project}/agents/${id}/`)} unavailable={!!live.error} />)}
      {!configured.length && <li className={styles.emptyAgents}>No agents configured</li>}
      <SidebarAction icon={<Plus />} onClick={onCreate}>Add agent</SidebarAction>
    </SidebarAccordion>
    {live.error && <Text role="alert" variant="meta" className={styles.emptyAgents}>Live activity unavailable</Text>}
  </>;
}

export function AppShell({ project, options, agents, children }: {
  project: string; options: readonly SidebarOption[]; agents: readonly string[]; children: ReactNode;
}) {
  const pathname = usePathname(), { navigate } = useNavigationGuard();
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
    <AgentNavigation project={project} agents={agents} pathname={pathname}
      onCreate={event => { createTrigger.current = event.currentTarget; setCreateOpen(true); }} />
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
    {settingsOpen && <SettingsDialog key={project} project={project} projectName={options.find(({ value }) => value === project)?.label}
      open onOpenChange={setSettingsOpen}
      onCloseAutoFocus={(event) => { event.preventDefault(); settingsTrigger.current?.focus(); }} />}
    {createOpen && <AgentCreateDialog key={project} project={project} open onOpenChange={setCreateOpen}
      onCreated={(name, editPrompt) => navigate(`/${project}/agents/${encodeURIComponent(name)}${editPrompt ? "/prompt" : ""}`)}
      onCloseAutoFocus={(event) => { event.preventDefault(); createTrigger.current?.focus(); }} />}
  </Stack>;
}
