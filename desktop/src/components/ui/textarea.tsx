"use client";

import type { ComponentPropsWithRef } from "react";
import { useField } from "../../hooks/use-field";
import { Field, type FieldDetails } from "./field";
import { Text } from "./text";
import styles from "./field.module.css";

type Props = ComponentPropsWithRef<"textarea"> & FieldDetails;

export function Textarea({ label, labelHidden, description, error, id, className = "", required, disabled,
  "aria-describedby": describedBy, "aria-invalid": invalid, ...props }: Props) {
  const field = useField({ id, description, error, describedBy });
  return (
    <Field {...{ label, labelHidden, description, error, required, disabled }} id={field.id}>
      <Text asChild><textarea {...props} id={field.id} required={required} disabled={disabled}
        aria-describedby={field.describedBy} aria-invalid={error ? true : invalid}
        className={`${styles.control} ${styles.textarea} ${className}`} /></Text>
    </Field>
  );
}
