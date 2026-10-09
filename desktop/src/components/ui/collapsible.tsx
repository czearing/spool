"use client";

import { Collapsible as Primitive, Slot } from "radix-ui";
import { ChevronRight } from "lucide-react";
import type { ComponentPropsWithRef } from "react";
import { Text } from "./text";
import { Stack } from "./stack";
import type { Space } from "./spacing";
import styles from "./collapsible.module.css";

export const Collapsible = Primitive.Root;
export function CollapsibleTrigger({ children, className = "", gap = 2, ...props }: ComponentPropsWithRef<typeof Primitive.Trigger> & { gap?: Space }) {
  return <Stack asChild direction="row" align="center" gap={gap}><Text asChild variant="action"><Primitive.Trigger {...props} className={`${styles.trigger} ${className}`}>
    <ChevronRight className={styles.chevron} aria-hidden="true" /><Slot.Slottable>{children}</Slot.Slottable>
  </Primitive.Trigger></Text></Stack>;
}
export function CollapsibleContent({ className = "", ...props }: ComponentPropsWithRef<typeof Primitive.Content>) {
  return <Primitive.Content {...props} className={`${styles.content} ${className}`} />;
}
// Native disclosures keep editable titles out of buttons and preserve editor DOM ownership.
export function createCollapsibleDOM(document: Document, open: boolean, onOpenChange: (open: boolean) => void) {
  const element = document.createElement("details");
  element.open = open; element.addEventListener("toggle", () => onOpenChange(element.open));
  return element;
}
export function createCollapsibleTitleDOM(document: Document) {
  const element = document.createElement("summary"); element.className = styles.trigger; return element;
}
export function createCollapsibleContentDOM(document: Document) {
  const element = document.createElement("div"); element.className = styles.content; return element;
}
