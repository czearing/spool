"use client";

import { Switch as Primitive } from "radix-ui";
import type { ComponentPropsWithRef } from "react";
import { useField } from "../../hooks/use-field";
import { Field, type FieldDetails } from "./field";
import styles from "./switch.module.css";

export function Switch({ label, labelHidden, description, error, id, disabled, className = "", ...props }:
  ComponentPropsWithRef<typeof Primitive.Root> & FieldDetails) {
  const field = useField({ id, description, error, describedBy: props["aria-describedby"] });
  return <Field id={field.id} label={label} labelHidden={labelHidden} description={description} error={error} disabled={disabled}>
    <Primitive.Root {...props} id={field.id} disabled={disabled} aria-describedby={field.describedBy}
      aria-invalid={error ? true : props["aria-invalid"]} className={`${styles.control} ${className}`}>
      <Primitive.Thumb className={styles.thumb} />
    </Primitive.Root>
  </Field>;
}
