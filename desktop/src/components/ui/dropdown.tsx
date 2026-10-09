"use client";

import { Select as Primitive } from "radix-ui";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { useField } from "../../hooks/use-field";
import { Field, type FieldDetails } from "./field";
import { Text } from "./text";
import { Stack } from "./stack";
import { popupPlacement } from "./primitive-tokens";
import styles from "./dropdown.module.css";

export type DropdownOption = { value: string; label: string; disabled?: boolean };
type Props = Omit<ComponentProps<typeof Primitive.Root>, "children"> & FieldDetails & {
  id?: string; placeholder?: string; options: readonly DropdownOption[]; "aria-describedby"?: string;
  density?: "default" | "compact"; icon?: ReactNode;
};

export function Dropdown({ label, labelHidden, description, error, id, placeholder = "Select an option", options, icon, density = "default",
  disabled, required, "aria-describedby": describedBy, ...props }: Props) {
  const field = useField({ id, description, error, describedBy });
  return (
    <Field {...{ label, labelHidden, description, error, required, disabled }} id={field.id}>
      <Primitive.Root {...props} required={required} disabled={disabled}>
        <Stack asChild direction="row" align="center" justify="space-between" gap={2}><Text asChild><Primitive.Trigger id={field.id} className={styles.trigger} data-density={density}
          aria-invalid={error ? true : undefined} aria-describedby={field.describedBy}>
          {icon && <span className={styles.icon} aria-hidden="true">{icon}</span>}
          <span className={styles.value}><Primitive.Value placeholder={placeholder} /></span>
          <Primitive.Icon asChild><ChevronDown className={styles.icon} aria-hidden="true" /></Primitive.Icon>
        </Primitive.Trigger></Text></Stack>
        <Primitive.Portal>
          <Text asChild><Primitive.Content position="popper" {...popupPlacement} aria-label={label} className={styles.content}>
            <Primitive.ScrollUpButton className={styles.scroll}><ChevronUp className={styles.icon} aria-hidden="true" /></Primitive.ScrollUpButton>
            <Primitive.Viewport className={styles.viewport}>
              {options.map(({ value, label: optionLabel, disabled: optionDisabled }) => (
                <Stack asChild direction="row" align="center" gap={2} key={value}><Primitive.Item value={value} disabled={optionDisabled} className={styles.item}>
                  <span className={styles.indicator}><Primitive.ItemIndicator><Check className={styles.icon} aria-hidden="true" /></Primitive.ItemIndicator></span>
                  <Primitive.ItemText>{optionLabel}</Primitive.ItemText>
                </Primitive.Item></Stack>
              ))}
            </Primitive.Viewport>
            <Primitive.ScrollDownButton className={styles.scroll}><ChevronDown className={styles.icon} aria-hidden="true" /></Primitive.ScrollDownButton>
          </Primitive.Content></Text>
        </Primitive.Portal>
      </Primitive.Root>
    </Field>
  );
}
