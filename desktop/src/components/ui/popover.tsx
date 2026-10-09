"use client";

import { Popover as Primitive } from "radix-ui";
import type { ComponentPropsWithRef } from "react";
import { popupPlacement } from "./primitive-tokens";
import styles from "./popover.module.css";

export const Popover = Primitive.Root;
export const PopoverTrigger = Primitive.Trigger;
export const PopoverAnchor = Primitive.Anchor;
export const PopoverClose = Primitive.Close;
export function PopoverContent({ label, density = "default", className = "", ...props }: ComponentPropsWithRef<typeof Primitive.Content> & {
  label: string; density?: "default" | "compact";
}) {
  return <Primitive.Portal><Primitive.Content {...popupPlacement} aria-label={label} data-density={density} {...props}
    className={`${styles.content} ${className}`} /></Primitive.Portal>;
}
