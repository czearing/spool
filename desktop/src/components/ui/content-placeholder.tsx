import styles from "./content-placeholder.module.css";

export function ContentPlaceholder({ label, compact = false }: { label: string; compact?: boolean }) {
  return <div role="status" aria-label={`${label} pending`} aria-busy="true"
    className={`${styles.placeholder} ${compact ? styles.compact : ""}`}>
    <span aria-hidden="true" /><span aria-hidden="true" /><span aria-hidden="true" />
  </div>;
}
