"use client";

import { Separator } from "radix-ui";
import type { ComponentPropsWithRef } from "react";
import styles from "./divider.module.css";

export function Divider({ decorative = true, orientation = "horizontal", className = "", ...props }: ComponentPropsWithRef<typeof Separator.Root>) {
  return <Separator.Root {...props} decorative={decorative} orientation={orientation} className={`${styles.divider} ${className}`} />;
}
