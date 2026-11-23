"use client";

import { Tabs } from "radix-ui";
import { createContext, useContext, type ComponentPropsWithRef } from "react";
import { Text } from "./text";
import { Stack } from "./stack";
import styles from "./pivot.module.css";

const Orientation = createContext<"horizontal" | "vertical">("horizontal");
export function Pivot({ className = "", orientation = "horizontal", ...props }: ComponentPropsWithRef<typeof Tabs.Root>) {
  return <Orientation.Provider value={orientation}><Stack asChild direction={orientation === "vertical" ? "row" : "column"} gap={orientation === "vertical" ? 4 : 0}>
    <Tabs.Root {...props} orientation={orientation} className={`${styles.root} ${className}`} />
  </Stack></Orientation.Provider>;
}

export function PivotList({ label, className = "", ...props }: ComponentPropsWithRef<typeof Tabs.List> & { label: string }) {
  const orientation = useContext(Orientation);
  return <Stack asChild direction={orientation === "vertical" ? "column" : "row"} gap={1}>
    <Tabs.List {...props} aria-label={label} className={`${styles.list} ${className}`} />
  </Stack>;
}

export function PivotTrigger({ className = "", ...props }: ComponentPropsWithRef<typeof Tabs.Trigger>) {
  return <Text asChild variant="action"><Tabs.Trigger {...props} className={`${styles.trigger} ${className}`} /></Text>;
}

export function PivotContent({ className = "", ...props }: ComponentPropsWithRef<typeof Tabs.Content>) {
  return <Text asChild><Tabs.Content {...props} className={`${styles.content} ${className}`} /></Text>;
}
