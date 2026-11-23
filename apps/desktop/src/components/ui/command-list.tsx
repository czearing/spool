"use client";

import type { ComponentPropsWithRef, ReactNode } from "react";
import { Text } from "./text";
import { Stack } from "./stack";
import styles from "./command-list.module.css";

export function CommandList({ label, children, className = "", ...props }: ComponentPropsWithRef<"div"> & { label: string }) {
  return <div {...props} className={`${styles.list} ${className}`}>
    <Text variant="meta" tone="secondary" className={styles.label}>{label}</Text>{children}
  </div>;
}
export function CommandItem({ icon, description, children, className = "", ...props }: ComponentPropsWithRef<"div"> & {
  icon?: ReactNode; description?: ReactNode;
}) {
  return <Stack {...props} direction="row" align="center" gap={3} className={`${styles.item} ${className}`}>
    {icon && <span className={styles.icon} aria-hidden="true">{icon}</span>}
    <span><Text variant="action">{children}</Text>
      {description && <Text variant="meta" tone="secondary" className={styles.description}>{description}</Text>}
    </span>
  </Stack>;
}
export function CommandEmpty({ children = "No matching commands.", className = "", ...props }: ComponentPropsWithRef<typeof Text>) {
  return <Text {...props} role="status" className={`${styles.empty} ${className}`}>{children}</Text>;
}
