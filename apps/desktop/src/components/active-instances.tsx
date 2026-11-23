import { StatusDot } from "./ui/status-dot";
import { Text } from "./ui/text";
import { Stack } from "./ui/stack";
import styles from "./active-instances.module.css";

export function ActiveInstances({ count, name, pending = 0, starting = 0 }: {
  count: number; name: string; pending?: number; starting?: number;
}) {
  if (!count && !pending && !starting) return null;
  return <Stack asChild direction="row" align="center" gap={2}><span>
    {([{ value: pending, state: "pending", tone: "neutral", unit: "task" },
      { value: starting, state: "starting", tone: "info", unit: "session" },
      { value: count, state: "active", tone: "success", unit: "session" }] as const).filter(item => item.value > 0).map(item =>
      <Stack asChild key={item.state} direction="row" align="center" gap={1}>
        <Text variant="meta" tabular className={styles.badge} data-state={item.state}
          aria-label={`${name}: ${item.value} ${item.state} ${item.unit}${item.value === 1 ? "" : "s"}`}>
          <StatusDot tone={item.tone} pulse={item.state !== "pending"} />
          <span>{item.value}</span>
        </Text>
      </Stack>)}
  </span></Stack>;
}
