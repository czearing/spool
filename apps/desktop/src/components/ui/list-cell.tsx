import type { ReactNode } from "react";
import { Text } from "./text";
import { Stack } from "./stack";
import styles from "./list.module.css";

export function ListCell({ children, description, icon, trailing }:
  { children: ReactNode; description?: ReactNode; icon?: ReactNode; trailing?: ReactNode }) {
  return (
    <Stack direction="row" align="start" gap={2}>
      {icon && <span className={styles.icon} aria-hidden="true">{icon}</span>}
      <Stack gap={0}>
        <Text variant={description ? "action" : "body"}>{children}</Text>
        {description && <Text variant="meta" tone="secondary">{description}</Text>}
      </Stack>
      {trailing && <span className={styles.trailing}>{trailing}</span>}
    </Stack>
  );
}
