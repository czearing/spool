"use client";

import type { ComponentPropsWithRef, ReactNode } from "react";
import { useField } from "../../hooks/use-field";
import { Field, type FieldDetails } from "./field";
import { Text } from "./text";
import { Stack } from "./stack";
import styles from "./field.module.css";

type Props = ComponentPropsWithRef<"input"> & FieldDetails & { density?: "default" | "compact"; endAction?: ReactNode; leadingIcon?: ReactNode };

export function Input({ label, labelHidden, density = "default", description, error, id, className = "", required, disabled, endAction, leadingIcon,
  "aria-describedby": describedBy, "aria-invalid": invalid, ...props }: Props) {
  const field = useField({ id, description, error, describedBy });
  const control = <Text asChild><input {...props} id={field.id} required={required} disabled={disabled} data-density={density}
    aria-describedby={field.describedBy} aria-invalid={error ? true : invalid}
    className={`${styles.control} ${className}`} /></Text>;
  const decorated = leadingIcon ? <span className={styles.adornedControl}>
    <span className={styles.leadingIcon} aria-hidden="true">{leadingIcon}</span>{control}
  </span> : control;
  return (
    <Field {...{ label, labelHidden, description, error, required, disabled }} id={field.id}>
      {endAction ? <Stack direction="row" align="center" gap={2}>{decorated}{endAction}</Stack> : decorated}
    </Field>
  );
}
