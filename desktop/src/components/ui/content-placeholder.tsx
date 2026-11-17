import styles from "./content-placeholder.module.css";
import { Stack } from "./stack";

export function ContentPlaceholder({ label, compact = false }: { label: string; compact?: boolean }) {
  return <Stack gap={compact ? 2 : 3} role="status" aria-label={`${label} pending`} aria-busy="true"
    className={`${styles.placeholder} ${compact ? styles.compact : ""}`}>
    <span aria-hidden="true" /><span aria-hidden="true" /><span aria-hidden="true" />
  </Stack>;
}
