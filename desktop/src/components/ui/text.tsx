"use client";

import { Slot } from "radix-ui";
import type { ComponentPropsWithRef } from "react";
import styles from "./text.module.css";

type Props = ComponentPropsWithRef<"span"> & {
  asChild?: boolean;
  variant?: "body" | "action" | "heading" | "meta";
  tone?: "secondary" | "muted";
  tabular?: boolean;
};

export function Text({ asChild = false, variant = "body", tone, tabular = false, className = "", ...props }: Props) {
  const Component = asChild ? Slot.Root : "span";
  return <Component className={[styles.text, styles[variant], tone && styles[tone], tabular && styles.tabular, className].filter(Boolean).join(" ")} {...props} />;
}
