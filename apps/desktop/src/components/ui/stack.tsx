"use client";

import { Slot } from "radix-ui";
import type { ComponentPropsWithRef } from "react";
import { space, type Space } from "./spacing";
import styles from "./layout.module.css";

type Props = ComponentPropsWithRef<"div"> & {
  asChild?: boolean;
  gap?: Space;
  direction?: "row" | "column";
  align?: "start" | "center" | "end" | "stretch";
  justify?: "start" | "center" | "end" | "space-between";
  wrap?: boolean;
};

export function Stack({ asChild = false, gap = 3, direction = "column", align = "stretch",
  justify = "start", wrap = false, className = "", style, ...props }: Props) {
  const Component = asChild ? Slot.Root : "div";
  return <Component className={`${styles.stack} ${className}`} style={{
    gap: space(gap), flexDirection: direction, alignItems: align, justifyContent: justify,
    flexWrap: wrap ? "wrap" : "nowrap", ...style,
  }} {...props} />;
}
