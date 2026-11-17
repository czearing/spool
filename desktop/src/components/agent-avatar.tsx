"use client";

import { Avatar } from "./ui/avatar";
import { memo } from "react";
import { useProjectLive } from "./project-live-provider";
import { useLocalImage } from "../hooks/use-local-image";

export function AgentAvatar({ agent }: { agent: string }) {
  const { project, data } = useProjectLive();
  const version = data?.agents.find(({ id }) => id === agent)?.imageVersion;
  return <AgentImage project={project} agent={agent} version={version} />;
}

export const AgentImage = memo(function AgentImage({ project, agent, version }: {
  project?: string; agent: string; version?: string | null;
}) {
  const src = project && version ? `/api/projects/${encodeURIComponent(project)}/agents/${encodeURIComponent(agent)}/image?v=${version}` : undefined;
  const image = useLocalImage(src);
  return <Avatar name={`${agent} image`} fallback={agent.charAt(0).toUpperCase()} src={image} size="small" aria-hidden="true" />;
});
