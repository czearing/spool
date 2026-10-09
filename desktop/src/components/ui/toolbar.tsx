"use client";

import { Toolbar as Primitive } from "radix-ui";
import type { ComponentPropsWithRef } from "react";
import { Divider } from "./divider";
import { Stack } from "./stack";
import type { Space } from "./spacing";
import styles from "./toolbar.module.css";

export function ToolbarButton(props: ComponentPropsWithRef<typeof Primitive.Button>) {
  return <Stack asChild direction="row" align="center" justify="center" gap={1}><Primitive.Button {...props} /></Stack>;
}
export const ToolbarLink = Primitive.Link;
export const ToolbarToggleGroup = Primitive.ToggleGroup;
export function ToolbarToggleItem(props: ComponentPropsWithRef<typeof Primitive.ToggleItem>) {
  return <Stack asChild direction="row" align="center" justify="center" gap={1}><Primitive.ToggleItem {...props} /></Stack>;
}
export function Toolbar({ className = "", loop = true, density = "default", gap = 1, orientation = "horizontal", ...props }: ComponentPropsWithRef<typeof Primitive.Root> & {
  density?: "default" | "compact"; gap?: Space;
}) {
  return <Stack asChild direction={orientation === "vertical" ? "column" : "row"} align={orientation === "vertical" ? "stretch" : "center"} gap={gap} wrap>
    <Primitive.Root {...props} orientation={orientation} loop={loop} data-density={density} className={`${styles.toolbar} ${className}`} />
  </Stack>;
}
export function ToolbarSeparator({ className = "", ...props }: ComponentPropsWithRef<typeof Primitive.Separator>) {
  return <Primitive.Separator {...props} asChild><Divider orientation="vertical" className={`${styles.separator} ${className}`} /></Primitive.Separator>;
}
