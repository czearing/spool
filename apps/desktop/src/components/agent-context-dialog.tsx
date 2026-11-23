"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { requestPrompt } from "../lib/prompt-api";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { Stack } from "./ui/stack";
import { Text } from "./ui/text";
import { Textarea } from "./ui/textarea";

export function AgentContextDialog({ project, agent, onClose }: { project: string; agent: string; onClose: () => void }) {
  const url = `/api/projects/${encodeURIComponent(project)}/agents/${encodeURIComponent(agent)}?scope=context`;
  const query = useQuery({ queryKey: ["agent-context", project, agent], retry: false, refetchOnWindowFocus: false,
    queryFn: ({ signal }) => requestPrompt(url, { signal }) });
  const [draft, setDraft] = useState("");
  useEffect(() => { if (query.data) setDraft(query.data.prompt); }, [query.data]);
  const mutation = useMutation({ retry: false, mutationFn: async () => {
    if (!query.data) throw new Error("Project instructions have not loaded.");
    return requestPrompt(url, { method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: draft, revision: query.data.revision }) });
  }, onSuccess: onClose });
  const error = mutation.error?.message ?? query.error?.message;
  return <Dialog open title="Project instructions" onOpenChange={open => { if (!open && !mutation.isPending) onClose(); }}
    description="Only this agent instance uses these instructions. Shared role instructions remain unchanged."
    footer={<><Button onClick={onClose} disabled={mutation.isPending}>Cancel</Button>
      <Button variant="primary" disabled={!query.data || query.isFetching || mutation.isPending}
        onClick={() => mutation.mutate()}>{mutation.isPending ? "Saving..." : "Save instructions"}</Button></>}>
    <Stack gap={4}>
      <Textarea label="Repository and task context" value={draft} rows={10} maxLength={16000}
        disabled={query.isFetching || mutation.isPending} onChange={event => setDraft(event.target.value)}
        description="Use this for repository paths, workspace rules, commands and project-specific boundaries."
        placeholder="For this project, work in..." />
      {query.isFetching && <Text role="status">Loading project instructions...</Text>}
      {error && <Stack gap={2}><Text role="alert">{error}</Text>
        <Button disabled={mutation.isPending} onClick={() => { mutation.reset(); void query.refetch(); }}>Reload project instructions</Button></Stack>}
    </Stack>
  </Dialog>;
}
