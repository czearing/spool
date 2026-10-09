"use client";

import { useRef, useState } from "react";
import { Toolbar } from "radix-ui";
import { Bot, CheckCheck, Clock3, FileClock, FolderSync, Hammer, RefreshCw, Terminal, Play, Webhook, Globe, Braces, Filter, type LucideIcon } from "lucide-react";
import { nodeCatalog, stepDefinition, type NodeChoice } from "../lib/runner-node-catalog";
import type { WorkflowStep } from "../lib/runner-workflow";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { Input } from "./ui/input";
import { Stack } from "./ui/stack";
import { Text } from "./ui/text";
import styles from "./runner-workflow.module.css";
import { integrationNames, operationAvailable } from "@spool/workflow";

const icons: Record<string, LucideIcon> = { clock: Clock3, file: FileClock, refresh: RefreshCw, folder: FolderSync,
  build: Hammer, check: CheckCheck, agent: Bot, terminal: Terminal, play: Play, webhook: Webhook, globe: Globe, data: Braces, filter: Filter };
export function stepIcon(step: WorkflowStep) {
  return icons[stepDefinition(step)?.icon ?? "refresh"];
}
export function RunnerNodePicker({ trigger, onSelect, onClose, container, source, existing }: {
  trigger: boolean; onSelect: (choice: NodeChoice) => void; onClose: () => void;
  container: HTMLElement | null;
  source?: string; existing?: boolean;
}) {
  const [search, setSearch] = useState("");
  const list = useRef<HTMLDivElement>(null);
  const available = nodeCatalog.filter(node => (node.group === "Triggers") === trigger && operationAvailable(node, source) &&
    (!trigger || !existing || ["azure-devops", "repository-event"].includes(node.kind)));
  const choices = available.filter((node, index) => available.findIndex(other => other.kind === node.kind) === index)
    .map(node => ({ ...node, label: integrationNames[node.kind] || node.label,
      description: integrationNames[node.kind] ? available.filter(other => other.kind === node.kind).map(other => other.label).join(", ") : node.description }))
    .filter(node => `${node.label} ${node.description} ${node.group}`.toLowerCase().includes(search.toLowerCase()));
  return <Dialog open modal={false} container={container} presentation="inspector" title={trigger ? "What starts this workflow?" : "What happens next?"}
    onOpenChange={open => { if (!open) onClose(); }}>
    <Stack gap={6}>
      <Input label="Search nodes" labelHidden placeholder="Search nodes..." value={search}
        onChange={event => setSearch(event.target.value)} onKeyDown={event => {
          if (event.key === "ArrowDown") { event.preventDefault(); list.current?.querySelector("button")?.focus(); }
        }} />
      <Toolbar.Root asChild orientation="vertical" loop aria-label="Available nodes"><Stack gap={6} ref={list}>
      {[...new Set(nodeCatalog.map(node => node.group))].map(group => {
        const items = choices.filter(node => node.group === group);
        return items.length > 0 && <Stack gap={2} key={group}>
          <Text variant="meta" tone="muted">{group === "Repository" ? "Repository / Bohemia" : group}</Text>
          {items.map(choice => {
            const Icon = icons[choice.icon];
            return <Toolbar.Button key={choice.id} asChild><Button className={styles.nodeChoice} onClick={() => onSelect(choice)}>
              <Icon className={styles.choiceIcon} aria-hidden="true" />
              <Stack asChild gap={1}><span><Text variant="action">{choice.label}</Text>
                <Text variant="meta" tone="secondary">{choice.description}</Text></span></Stack>
            </Button></Toolbar.Button>;
          })}
        </Stack>;
      })}
      </Stack></Toolbar.Root>
      {!choices.length && <Text role="status" tone="muted">No matching nodes.</Text>}
    </Stack>
  </Dialog>;
}
