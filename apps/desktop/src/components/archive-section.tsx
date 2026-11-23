import type { ComponentPropsWithRef, ReactNode } from "react";
import { Accordion } from "./ui/accordion";
import { Divider } from "./ui/divider";
import { Text } from "./ui/text";
import styles from "./board.module.css";

export function ArchiveSection({ count, description, children, className = "", ...props }: ComponentPropsWithRef<"section"> & {
  count: number; description?: ReactNode;
}) {
  return <section id="archive" aria-label="Archive" {...props} className={`${styles.archive} ${className}`}>
    <Divider className={styles.archiveDivider} />
    <Accordion title={<>Archive <Text variant="meta" tone="secondary" tabular>({count})</Text></>}>
      {description && <Text asChild variant="meta" tone="secondary"><p className={styles.archiveDescription}>{description}</p></Text>}
      {children}
    </Accordion>
  </section>;
}
