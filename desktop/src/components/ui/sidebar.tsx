"use client";

import { useId, type ComponentPropsWithRef, type ComponentType, type ReactNode } from "react";
import { ChevronsUpDown } from "lucide-react";
import { Avatar } from "./avatar";
import { Accordion } from "./accordion";
import { Button } from "./button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./collapsible";
import { Divider } from "./divider";
import { Text } from "./text";
import { Stack } from "./stack";
import { Menu, MenuContent, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger } from "./menu";
import styles from "./sidebar.module.css";

type SidebarProps = ComponentPropsWithRef<"aside"> & {
  label: string; header?: ReactNode; footer?: ReactNode;
};
export function Sidebar({ label, header, footer, children, className = "", ...props }: SidebarProps) {
  return <Stack asChild gap={0}><aside {...props} className={`${styles.sidebar} ${className}`}>
    {header && <div className={styles.header}>{header}</div>}
    <Stack asChild gap={6}><nav aria-label={label} className={styles.navigation}>{children}</nav></Stack>
    {footer && <div className={styles.footer}><Divider /><div className={styles.footerContent}>{footer}</div></div>}
  </aside></Stack>;
}

export type SidebarOption = { value: string; label: string; disabled?: boolean };
export function SidebarSwitcher({ label, value, options, onValueChange, disabled, actions, onCloseAutoFocus, ref }: {
  label: string; value: string; options: readonly SidebarOption[]; onValueChange: (value: string) => void; disabled?: boolean;
  actions?: ReactNode; onCloseAutoFocus?: ComponentPropsWithRef<typeof MenuContent>["onCloseAutoFocus"];
  ref?: ComponentPropsWithRef<typeof Button>["ref"];
}) {
  const selected = options.find((option) => option.value === value);
  if (!selected) throw new Error("SidebarSwitcher value must match an option.");
  return <Menu><MenuTrigger asChild>
    <Stack asChild direction="row" align="center" gap={2}><Button ref={ref} className={styles.switcher} disabled={disabled} aria-label={`${label}, ${selected.label}`}>
      <Avatar name={selected.label} fallback={selected.label.slice(0, 1)} size="small" />
      <Text variant="heading" className={styles.label}>{selected.label}</Text><ChevronsUpDown aria-hidden="true" />
    </Button></Stack>
  </MenuTrigger><MenuContent onCloseAutoFocus={onCloseAutoFocus}>
    <MenuLabel>{label}</MenuLabel><MenuRadioGroup value={value} onValueChange={onValueChange}>
      {options.map((option) => <MenuRadioItem key={option.value} value={option.value} disabled={option.disabled}>
        {option.label}{option.disabled && <Text variant="meta" tone="secondary"> (not configured)</Text>}
      </MenuRadioItem>)}
    </MenuRadioGroup>
    {actions && <><MenuSeparator />{actions}</>}
  </MenuContent></Menu>;
}

type GroupProps = {
  children: ReactNode; className?: string; open?: boolean; defaultOpen?: boolean; onOpenChange?: (open: boolean) => void;
} & ({ collapsible: true; label: string } | { collapsible?: false; label?: string });
export function SidebarGroup({ label, children, collapsible, open, defaultOpen = true, onOpenChange, className = "" }: GroupProps) {
  const id = useId();
  const list = <Stack asChild gap={1}><ul className={styles.list}>{children}</ul></Stack>;
  const heading = label && <Text asChild variant="meta" tone="secondary"><h2 id={id} className={styles.groupLabel}>{label}</h2></Text>;
  if (!collapsible) return <section className={`${styles.group} ${className}`} aria-labelledby={label ? id : undefined}>{heading}{list}</section>;
  return <Collapsible asChild open={open} defaultOpen={defaultOpen} onOpenChange={onOpenChange}>
    <section className={`${styles.group} ${className}`} aria-labelledby={id}>
      <h2 className={styles.groupHeading}><CollapsibleTrigger id={id} gap={1} className={styles.groupTrigger}>{label}</CollapsibleTrigger></h2>
      <CollapsibleContent className={styles.groupContent}>{list}</CollapsibleContent>
    </section>
  </Collapsible>;
}

type ItemProps = ComponentPropsWithRef<"a"> & {
  href: string; icon?: ReactNode; badge?: ReactNode; actions?: ReactNode; active?: boolean;
  linkComponent?: "a" | ComponentType<ComponentPropsWithRef<"a"> & { href: string }>;
};
export function SidebarAccordion({ label, children, badge, defaultOpen = false }: {
  label: string; children: ReactNode; badge?: ReactNode; defaultOpen?: boolean;
}) {
  return <section className={styles.group}><Accordion title={<Stack asChild direction="row" align="center" gap={2}><span>{label}{badge}</span></Stack>} density="compact" defaultOpen={defaultOpen}>
    <Stack asChild gap={1}><ul className={styles.list}>{children}</ul></Stack>
  </Accordion></section>;
}
export function SidebarItem({ icon, badge, actions, active, children, linkComponent: Link = "a", className = "", ...props }: ItemProps) {
  return <Stack asChild direction="row" align="center" gap={0}><li className={styles.listItem}><Stack asChild direction="row" align="center" gap={2}><Button asChild className={`${styles.item} ${className}`}>
    <Link aria-current={active ? "page" : undefined} {...props}>
      {icon && <span className={styles.icon} aria-hidden="true">{icon}</span>}
      <span className={styles.label}>{children}</span>
      {badge != null && <Text variant="meta" tone="secondary" tabular className={styles.badge}>{badge}</Text>}
    </Link>
  </Button></Stack>{actions && <div className={styles.actions}>{actions}</div>}</li></Stack>;
}

export function SidebarAction({ icon, children, className = "", ...props }: ComponentPropsWithRef<typeof Button> & { icon?: ReactNode }) {
  return <li className={styles.listItem}><Stack asChild direction="row" align="center" gap={2}>
    <Button className={`${styles.item} ${className}`} {...props}>
      {icon && <span className={styles.icon} aria-hidden="true">{icon}</span>}
      <span className={styles.label}>{children}</span>
    </Button>
  </Stack></li>;
}

type BranchProps = Omit<ComponentPropsWithRef<typeof Collapsible>, "asChild"> & { label: string };
export function SidebarBranch({ label, children, className = "", ...props }: BranchProps) {
  return <Collapsible asChild {...props}><li className={`${styles.branch} ${className}`}>
    <CollapsibleTrigger className={styles.branchTrigger}><span className={styles.label}>{label}</span></CollapsibleTrigger>
    <CollapsibleContent className={styles.branchContent}><Stack asChild gap={1}><ul className={styles.list}>{children}</ul></Stack></CollapsibleContent>
  </li></Collapsible>;
}
