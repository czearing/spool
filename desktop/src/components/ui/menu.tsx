"use client";

import { DropdownMenu as Primitive, Slot } from "radix-ui";
import { Check, ChevronRight } from "lucide-react";
import type { ComponentPropsWithRef, ReactNode } from "react";
import { Text } from "./text";
import { Stack } from "./stack";
import { CheckboxIndicator } from "./checkbox";
import { Divider } from "./divider";
import { popupPlacement } from "./primitive-tokens";
import styles from "./menu.module.css";

export const Menu = Primitive.Root;
export const MenuTrigger = Primitive.Trigger;
export const MenuGroup = Primitive.Group;
export const MenuSub = Primitive.Sub;
export const MenuRadioGroup = Primitive.RadioGroup;

type WithIcon = { icon?: ReactNode };
function MenuIcon({ icon }: WithIcon) {
  return icon ? <span className={styles.leadingIcon} aria-hidden="true">{icon}</span> : null;
}

export function MenuContent({ className = "", ...props }: ComponentPropsWithRef<typeof Primitive.Content>) {
  return <Primitive.Portal><Text asChild><Primitive.Content {...popupPlacement} align="start" loop
    {...props} className={`${styles.content} ${className}`} /></Text></Primitive.Portal>;
}

export function MenuItem({ icon, children, className = "", ...props }: ComponentPropsWithRef<typeof Primitive.Item> & WithIcon) {
  return <Stack asChild direction="row" align="center" gap={2}><Text asChild variant="action"><Primitive.Item {...props} className={`${styles.item} ${className}`}>
    <MenuIcon icon={icon} /><Slot.Slottable>{children}</Slot.Slottable>
  </Primitive.Item></Text></Stack>;
}

export function MenuSubTrigger({ children, icon, className = "", ...props }: ComponentPropsWithRef<typeof Primitive.SubTrigger> & WithIcon) {
  return <Stack asChild direction="row" align="center" gap={2}><Text asChild variant="action"><Primitive.SubTrigger {...props} className={`${styles.item} ${className}`}>
    <MenuIcon icon={icon} /><Slot.Slottable>{children}</Slot.Slottable><ChevronRight className={`${styles.icon} ${styles.chevron}`} aria-hidden="true" />
  </Primitive.SubTrigger></Text></Stack>;
}

export function MenuSubContent({ className = "", ...props }: ComponentPropsWithRef<typeof Primitive.SubContent>) {
  return <Primitive.Portal><Text asChild><Primitive.SubContent {...popupPlacement} loop
    {...props} className={`${styles.content} ${className}`} /></Text></Primitive.Portal>;
}

export function MenuCheckboxItem({ children, icon, checked, className = "", ...props }: ComponentPropsWithRef<typeof Primitive.CheckboxItem> & WithIcon) {
  return <Stack asChild direction="row" align="center" gap={2}><Text asChild variant="action"><Primitive.CheckboxItem {...props} checked={checked} className={`${styles.item} ${className}`}>
    <span className={styles.indicator}><Primitive.ItemIndicator asChild><CheckboxIndicator /></Primitive.ItemIndicator></span>
    <MenuIcon icon={icon} /><Slot.Slottable>{children}</Slot.Slottable>
  </Primitive.CheckboxItem></Text></Stack>;
}

export function MenuRadioItem({ children, icon, className = "", ...props }: ComponentPropsWithRef<typeof Primitive.RadioItem> & WithIcon) {
  return <Stack asChild direction="row" align="center" gap={2}><Text asChild variant="action"><Primitive.RadioItem {...props} className={`${styles.item} ${className}`}>
    <span className={styles.indicator}><Primitive.ItemIndicator><Check className={styles.icon} aria-hidden="true" /></Primitive.ItemIndicator></span>
    <MenuIcon icon={icon} /><Slot.Slottable>{children}</Slot.Slottable>
  </Primitive.RadioItem></Text></Stack>;
}

export function MenuLabel({ className = "", ...props }: ComponentPropsWithRef<typeof Primitive.Label>) {
  return <Text asChild variant="meta" tone="secondary"><Primitive.Label {...props} className={`${styles.label} ${className}`} /></Text>;
}

export function MenuSeparator({ className = "", ...props }: ComponentPropsWithRef<typeof Primitive.Separator>) {
  return <Primitive.Separator {...props} asChild><Divider className={`${styles.separator} ${className}`} /></Primitive.Separator>;
}
