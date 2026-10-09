"use client";

import { Checkbox as Primitive, Label } from "radix-ui";
import { Check, Minus } from "lucide-react";
import type { ComponentPropsWithRef, ReactNode } from "react";
import { useField } from "../../hooks/use-field";
import { Text } from "./text";
import { Stack } from "./stack";
import styles from "./checkbox.module.css";

export function CheckboxIndicator({ className = "", ...props }: ComponentPropsWithRef<"span">) {
  return <span {...props} aria-hidden="true" className={`${styles.indicator} ${className}`}>
    <Check className={styles.check} /><Minus className={styles.mixed} />
  </span>;
}
export type CheckboxProps = ComponentPropsWithRef<typeof Primitive.Root> & {
  label?: string; description?: ReactNode; error?: string;
};
export function Checkbox({ label, description, error, id, className = "", disabled, required,
  "aria-describedby": describedBy, "aria-invalid": invalid, ...props }: CheckboxProps) {
  const field = useField({ id, description, error, describedBy });
  const control = <Primitive.Root {...props} id={field.id} disabled={disabled} required={required}
    aria-describedby={field.describedBy} aria-invalid={error ? true : invalid}
    className={`${styles.control} ${className}`}>
    <span className={styles.box}><Primitive.Indicator asChild><CheckboxIndicator /></Primitive.Indicator></span>
  </Primitive.Root>;
  if (!label && !description && !error) return control;
  return <Stack asChild gap={1}><span className={styles.field} data-disabled={disabled || undefined}>
    <Stack asChild direction="row" align="center" gap={2}><span>{control}
      {label && <Text asChild><Label.Root htmlFor={field.id}>{label}{required && <Text variant="meta" tone="secondary"> (required)</Text>}</Label.Root></Text>}
    </span></Stack>
    {description && <Text id={`${field.id}-description`} tone="secondary" className={styles.detail}>{description}</Text>}
    {error && <Text id={`${field.id}-error`} role="alert" className={styles.detail}>{error}</Text>}
  </span></Stack>;
}
