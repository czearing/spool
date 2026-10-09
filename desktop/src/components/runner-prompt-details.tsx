import type { RunnerWorkflow } from "@spool/workflow";
import { Textarea } from "./ui/textarea";
import { Text } from "./ui/text";
import styles from "./runner-node-details.module.css";

export function RunnerPromptDetails({ detail }: { detail?: NonNullable<RunnerWorkflow["inspection"]>[string] }) {
  if (!detail) return null;
  return <>
    {detail.prompt && <details className={styles.help}>
      <summary>Generated event instructions</summary>
      <Text variant="meta" tone="secondary">Delivered task preview. Save to refresh; placeholders vary per run.</Text>
      <Textarea label="Task handoff prompt" value={detail.prompt} readOnly rows={14} />
    </details>}
    {(detail.agentInstructions || detail.agentSource || detail.error) && <details className={styles.help}>
      <summary>Agent instructions</summary>
      <Text variant="meta" tone="secondary">{detail.agentSource}</Text>
      {detail.agentInstructions && <Textarea label="Agent instructions" value={detail.agentInstructions} readOnly rows={14} />}
      {detail.error && <Text role="alert">{detail.error}</Text>}
    </details>}
  </>;
}
