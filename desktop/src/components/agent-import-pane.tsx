"use client";

import { useEffect, useState } from "react";
import { RadioGroup } from "radix-ui";
import { Bot, Check, Link2 } from "lucide-react";
import type { AgentCatalog, ImportAgent } from "../lib/agent-import";
import type { AgentSource } from "../hooks/use-agent-import";
import type { AgentPrompt } from "../lib/agents";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Stack } from "./ui/stack";
import { Text } from "./ui/text";
import styles from "./agent-import-pane.module.css";

export function AgentImportPane({ id, catalog, source, preview, loading, previewLoading, pending, error, onSelect, onImport, onReload }: {
  id: string; catalog?: AgentCatalog; source?: AgentSource; preview?: AgentPrompt; loading?: boolean; previewLoading?: boolean;
  pending?: boolean; error?: string; onSelect: (source: AgentSource) => void; onImport: (input: ImportAgent) => void; onReload: () => void;
}) {
  const [search, setSearch] = useState(""), [name, setName] = useState("");
  useEffect(() => { setName(source?.agent.toLowerCase().replaceAll("_", "-").slice(0, 64) ?? ""); }, [source?.project, source?.agent]);
  const options = catalog?.projects.flatMap(project => project.agents.map(agent => ({
    project: project.id, projectName: project.name, agent, key: `${project.id}:${agent}`,
  }))).filter(option => `${option.agent} ${option.projectName}`.toLowerCase().includes(search.trim().toLowerCase())) ?? [];
  const select = (key: string) => { const option = options.find(option => option.key === key); if (option) onSelect(option); };
  return <Stack asChild gap={4}><form id={id} aria-busy={pending} onSubmit={event => {
    event.preventDefault();
    if (!source || !preview || previewLoading || pending) return;
    onImport({ name, context: "", sourceProject: source.project, sourceAgent: source.agent, revision: preview.revision });
  }}>
    <Input label="Search agents" labelHidden type="search" placeholder="Search agents or projects..." value={search}
      disabled={pending} onChange={event => setSearch(event.target.value)} />
    {loading ? <Text role="status" tone="secondary">Loading agents...</Text> : <>
      <RadioGroup.Root aria-label="Agents from other projects" value={source ? `${source.project}:${source.agent}` : ""}
        onValueChange={select} disabled={pending} className={styles.library}>
        <Stack gap={1}>{options.map(option => <RadioGroup.Item key={option.key} value={option.key} asChild>
          <Button className={styles.option} aria-label={`${option.agent} from ${option.projectName}`}>
            <span className={styles.icon}><Bot aria-hidden="true" /></span>
            <Stack asChild gap={0}><span className={styles.label}><Text variant="action">{option.agent}</Text>
              <Text variant="meta" tone="secondary">{option.projectName}</Text></span></Stack>
            {source?.project === option.project && source.agent === option.agent && <Check aria-hidden="true" />}
          </Button>
        </RadioGroup.Item>)}</Stack>
      </RadioGroup.Root>
      {!options.length && <Text role="status" tone="secondary">{search ? "No matching agents." : "No agents in other projects yet."}</Text>}
      {catalog?.projects.filter(project => project.error).map(project =>
        <Text key={project.id} role="alert">{project.name}: {project.error}</Text>)}
    </>}
    {source && <Stack gap={4}>
      <Stack gap={2}>
        <Stack direction="row" align="center" gap={2}><Link2 className={styles.smallIcon} aria-hidden="true" />
          <Text variant="action">{source.agent} / {source.projectName}</Text></Stack>
        <Text variant="meta" tone="secondary">Shared edits apply to new sessions. Settings and history stay local.</Text>
        {previewLoading ? <Text role="status">Loading preview...</Text> :
          preview && <div className={styles.preview} role="region" aria-label="Shared instructions preview" tabIndex={0}><pre>{preview.prompt}</pre></div>}
      </Stack>
      <Input label="Name in this project" value={name} onChange={event => setName(event.target.value)} disabled={pending}
        required pattern="[a-z][a-z0-9-]{0,63}" maxLength={64} description="Lowercase letters, numbers and hyphens." />
    </Stack>}
    {error && <Stack gap={2}><Text role="alert">{error}</Text><Button disabled={pending} onClick={onReload}>Reload library and preview</Button></Stack>}
  </form></Stack>;
}
