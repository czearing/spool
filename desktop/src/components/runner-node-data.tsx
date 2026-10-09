import { Braces } from "lucide-react";
import { Stack } from "./ui/stack";
import { Text } from "./ui/text";
import styles from "./runner-node-details.module.css";

export function RunnerNodeData({ title, value, available, error }: {
  title: string; value?: unknown; available: boolean; error?: string;
}) {
  return <section className={styles.dataPane} aria-label={title}>
    <Stack direction="row" align="center" justify="space-between" gap={2} className={styles.dataHeader}>
      <Text variant="action">{title}</Text><Text variant="meta" tone="muted">JSON</Text>
    </Stack>
    {error && <Text role="alert" className={styles.dataError}>{error}</Text>}
    {available ? <pre className={styles.json}>{JSON.stringify(value, null, 2)}</pre> :
      <Stack align="center" justify="center" gap={3} className={styles.noData}>
        <Braces aria-hidden="true" /><Text variant="action">No {title.toLowerCase()} data</Text>
        <Text variant="meta" tone="secondary">Select an execution with recorded data.</Text>
      </Stack>}
  </section>;
}
