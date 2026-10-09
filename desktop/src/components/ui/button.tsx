"use client";

import { Slot } from "radix-ui";
import type { ComponentPropsWithRef } from "react";
import { Text } from "./text";
import { space } from "./spacing";
import styles from "./button.module.css";

type Props = ComponentPropsWithRef<"button"> & { asChild?: boolean; variant?: "secondary" | "primary" };

export function Button({ asChild = false, variant = "secondary", className = "", type = "button", style, ...props }: Props) {
  const Component = asChild ? Slot.Root : "button";
  return <Text asChild variant="action"><Component type={asChild ? undefined : type} data-variant={variant} className={`${styles.button} ${className}`} style={{ gap: space(2), ...style }} {...props} /></Text>;
}
