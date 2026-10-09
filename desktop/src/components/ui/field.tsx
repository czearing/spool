"use client";

import { Label, VisuallyHidden } from "radix-ui";
import type { ReactNode } from "react";
import { Stack } from "./stack";
import { Text } from "./text";
import styles from "./field.module.css";

export type FieldDetails = { label: string; labelHidden?: boolean; description?: ReactNode; error?: string };

export function Field({ id, label, labelHidden, description, error, required, disabled, children }: FieldDetails & {
  id: string; required?: boolean; disabled?: boolean; children: ReactNode;
}) {
  const caption = <Text asChild variant="action"><Label.Root htmlFor={id} className={styles.label}>
    {label}{required && !labelHidden && <Text variant="meta" tone="secondary"> (required)</Text>}
  </Label.Root></Text>;
  return (
    <Stack gap={2} className={styles.field} data-disabled={disabled || undefined}>
      {labelHidden ? <VisuallyHidden.Root asChild>{caption}</VisuallyHidden.Root> : caption}
      {children}
      {description && <Text id={`${id}-description`} tone="secondary">{description}</Text>}
      {error && <Text id={`${id}-error`} role="alert">{error}</Text>}
    </Stack>
  );
}
