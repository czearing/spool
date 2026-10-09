"use client";

import { memo } from "react";
import { Terminal } from "lucide-react";
import type { ConversationTool } from "../lib/conversation-tools";
import { Accordion } from "./ui/accordion";
import { Stack } from "./ui/stack";
import { Text } from "./ui/text";
import { StatusDot } from "./ui/status-dot";
import { Timestamp } from "./ui/timestamp";
import styles from "./task-chat.module.css";

export const TaskToolCall = memo(function TaskToolCall({ tool, open, onOpenChange }: {
  tool: ConversationTool; open?: boolean; onOpenChange?: (open: boolean) => void;
}) {
  return <article aria-label={`Tool: ${tool.name}`} className={styles.tool}>
    <Accordion density="compact" open={open} onOpenChange={onOpenChange} title={<Stack asChild direction="row" align="center" gap={2}>
      <span><Terminal size={16} aria-hidden /><Text className={styles.toolName}>{tool.name}</Text>
        <StatusDot tone={tool.status === "Failed" ? "danger" : tool.status === "Completed" ? "success" : "neutral"} />
        <Text variant="meta" tone="muted">{tool.status}</Text></span>
    </Stack>}>
      <Stack gap={3}>
        <Text variant="meta" tone="muted"><Timestamp value={tool.startedAt} timeZone="local" />
          {!tool.completedAt && " · No completion recorded."}</Text>
        {tool.input && <Stack gap={1}><Text variant="meta" tone="muted">Input</Text><pre tabIndex={0} className={styles.toolOutput}>{tool.input}</pre></Stack>}
        {tool.output && <Stack gap={1}><Text variant="meta" tone="muted">Output</Text><pre tabIndex={0} className={styles.toolOutput}>{tool.output}</pre></Stack>}
        {tool.status === "Completed" && !tool.output && <Text variant="meta" tone="muted">Completed without text output.</Text>}
      </Stack>
    </Accordion>
  </article>;
});
