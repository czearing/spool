"use client";

import { Accordion as Primitive } from "radix-ui";
import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "./button";
import { Text } from "./text";
import { Stack } from "./stack";
import styles from "./accordion.module.css";

export function Accordion({ title, children, defaultOpen = false, density = "default", open, onOpenChange }: {
  title: ReactNode; children: ReactNode; defaultOpen?: boolean; density?: "default" | "compact";
  open?: boolean; onOpenChange?: (open: boolean) => void;
}) {
  return (
    <Primitive.Root type="single" collapsible data-density={density} defaultValue={defaultOpen ? "content" : undefined}
      value={open === undefined ? undefined : open ? "content" : ""} onValueChange={value => onOpenChange?.(value === "content")}>
      <Primitive.Item value="content">
        <Primitive.Header asChild>
          <Text asChild variant="heading"><h2 className={styles.heading}>
            <Primitive.Trigger asChild>
              <Stack asChild direction="row" align="center" justify="space-between" gap={3}><Button className={styles.trigger}>
                <Text variant="heading" className={styles.title}>{title}</Text>
                <ChevronDown className={styles.chevron} size={16} strokeWidth={1.75} aria-hidden="true" focusable="false" />
              </Button></Stack>
            </Primitive.Trigger>
          </h2></Text>
        </Primitive.Header>
        <Primitive.Content className={styles.content}><Text asChild><div className={styles.body}>{children}</div></Text></Primitive.Content>
      </Primitive.Item>
    </Primitive.Root>
  );
}
