"use client";

import { useDeleteAgent } from "../hooks/use-delete-agent";
import dynamic from "../platform/lazy";
import { NavigationLink } from "./navigation-link";
const AgentActionsMenu = dynamic(() => import("./agent-actions-menu").then((module) => module.AgentActionsMenu));
const SettingsDialog = dynamic(() => import("./settings-dialog").then((module) => module.SettingsDialog));

export function AgentActions({ project, agent, compact = false }: { project: string; agent: string; compact?: boolean }) {
  const mutation = useDeleteAgent(project, agent);
  return <AgentActionsMenu agent={agent} compact={compact} label={compact ? `${agent} actions` : "Agent actions"}
    editLink={<NavigationLink href={`/${project}/agents/${encodeURIComponent(agent)}/prompt`}>Edit prompt</NavigationLink>}
    settings={(props) => props.open && <SettingsDialog {...props} project={project} agent={agent} />}
    onDelete={() => mutation.mutate()} deleting={mutation.isPending} error={mutation.error?.message} onReset={mutation.reset} />;
}
