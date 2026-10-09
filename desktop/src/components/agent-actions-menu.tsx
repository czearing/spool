"use client";

import { useRef, useState, type ReactElement, type ReactNode } from "react";
import { Ellipsis, Pencil, Settings, Trash2 } from "lucide-react";
import { Button } from "./ui/button";
import { Dialog, DialogClose } from "./ui/dialog";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "./ui/menu";
import { Text } from "./ui/text";
import styles from "./agent-actions-menu.module.css";

export function AgentActionsMenu({ agent, editLink, onDelete, deleting = false, error, onReset, settings, label = "Agent actions", compact = false }: {
  agent: string; editLink: ReactElement; onDelete: () => void; deleting?: boolean; error?: string; onReset?: () => void;
  label?: string; compact?: boolean;
  settings?: (props: { open: boolean; onOpenChange: (open: boolean) => void; onCloseAutoFocus: (event: Event) => void }) => ReactNode;
}) {
  const trigger = useRef<HTMLButtonElement>(null), [confirming, setConfirming] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const restoreFocus = (event: Event) => { event.preventDefault(); trigger.current?.focus(); };
  return <>
    <Menu>
      <MenuTrigger asChild><Button ref={trigger} className={styles.trigger} data-compact={compact} aria-label={label} disabled={deleting}>
        <Ellipsis className={styles.icon} aria-hidden="true" />
      </Button></MenuTrigger>
      <MenuContent align="end" onCloseAutoFocus={(event) => { if (confirming || settingsOpen) event.preventDefault(); }}>
        <MenuItem asChild icon={<Pencil />}>{editLink}</MenuItem>
        {settings && <MenuItem icon={<Settings />} onSelect={() => setSettingsOpen(true)}>Settings</MenuItem>}
        <MenuSeparator />
        <MenuItem icon={<Trash2 />} onSelect={() => { onReset?.(); setConfirming(true); }}>Delete agent</MenuItem>
      </MenuContent>
    </Menu>
    <Dialog open={confirming} onOpenChange={(open) => { if (!deleting) setConfirming(open); }} title="Delete agent?"
      description={`This permanently removes ${agent}'s configuration and prompt file. Job history is kept. Agents with queued or in-progress work cannot be deleted.`}
      onCloseAutoFocus={restoreFocus}
      footer={<><DialogClose asChild><Button disabled={deleting}>Cancel</Button></DialogClose>
        <Button variant="primary" disabled={deleting} onClick={onDelete}>{deleting ? "Deleting..." : "Delete agent"}</Button></>}>
      {error && <Text role="alert">{error}</Text>}
    </Dialog>
    {settings?.({ open: settingsOpen, onOpenChange: setSettingsOpen, onCloseAutoFocus: restoreFocus })}
  </>;
}
