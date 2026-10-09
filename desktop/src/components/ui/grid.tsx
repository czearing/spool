"use client";

import { Slot } from "radix-ui";
import type { ComponentPropsWithRef, CSSProperties } from "react";
import { space, type Space } from "./spacing";
import styles from "./layout.module.css";

type Props = ComponentPropsWithRef<"div"> & { asChild?: boolean; columns?: 1 | 2 | 3 | 4; gap?: Space };

export function Grid({ asChild = false, columns = 1, gap = 4, className = "", style, ...props }: Props) {
  const Component = asChild ? Slot.Root : "div";
  const layout: CSSProperties & { "--columns": number } = { "--columns": columns, gap: space(gap), ...style };
  return <Component className={`${styles.grid} ${className}`} style={layout} {...props} />;
}
