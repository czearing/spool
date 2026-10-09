import styles from "./status-dot.module.css";

export function StatusDot({ label, pulse = false, tone = "success" }: {
  label?: string; pulse?: boolean; tone?: "success" | "info" | "danger" | "neutral";
}) {
  return <span className={styles.dot} data-tone={tone} data-pulse={pulse}
    role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true} />;
}
