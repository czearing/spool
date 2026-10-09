"use client";

import { useRef, useState } from "react";
import { Archive, Ellipsis } from "lucide-react";
import { Button } from "./ui/button";
import { Dialog, DialogClose } from "./ui/dialog";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "./ui/menu";
import { Text } from "./ui/text";
import styles from "./board.module.css";

export function ColumnArchiveMenu({ label, count, pending = false, onArchive }: {
  label: string; count: number; pending?: boolean; onArchive: () => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);
  const busy = pending || saving;
  return <>
    <Menu><MenuTrigger asChild><Button ref={trigger} className={styles.addIcon} aria-label={`${label} actions`} aria-busy={busy}>
      <Ellipsis aria-hidden="true" />
    </Button></MenuTrigger><MenuContent align="end">
      <MenuItem icon={<Archive />} disabled={!count || busy} onSelect={() => { setError(""); setOpen(true); }}>Move all to archive</MenuItem>
    </MenuContent></Menu>
    <Dialog open={open} onOpenChange={(value) => { if (!busy) setOpen(value); }} title={`Archive all ${label.toLowerCase()} tasks?`}
      onCloseAutoFocus={(event) => { event.preventDefault(); trigger.current?.focus(); }}
      description={`Move all ${count} tasks in this column to the archive, including tasks hidden by filters. Conversations are kept.`}
      footer={<><DialogClose asChild><Button disabled={busy}>Cancel</Button></DialogClose>
        <Button variant="primary" disabled={busy || !count} onClick={async () => {
          setSaving(true); setError(""); setOpen(false);
          try { await onArchive(); }
          catch (cause) { setError(cause instanceof Error ? cause.message : "Could not confirm archiving. Refresh before retrying."); setOpen(true); }
          finally { setSaving(false); }
        }}>{busy ? "Archiving..." : "Move all to archive"}</Button></>}>
      {error && <Text role="alert">{error}</Text>}
    </Dialog>
  </>;
}
