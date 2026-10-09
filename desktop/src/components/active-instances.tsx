import { StatusDot } from "./ui/status-dot";
import { Text } from "./ui/text";
import { Stack } from "./ui/stack";
import styles from "./active-instances.module.css";

export function ActiveInstances({ count, name }: { count: number; name: string }) {
  if (!count) return null;
  return <Stack asChild direction="row" align="center" gap={1}><Text variant="meta" tabular className={styles.badge} aria-label={`${name}: ${count} active ${count === 1 ? "session" : "sessions"}`}>
    <StatusDot pulse /><span>{count}</span>
  </Text></Stack>;
}
