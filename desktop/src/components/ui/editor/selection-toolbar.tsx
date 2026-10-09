import { useRef, useState, type ReactNode } from "react";
import { Popover, PopoverAnchor, PopoverContent } from "../popover";
import { Toolbar } from "../toolbar";
import styles from "./editor.module.css";
export function SelectionToolbar({ range, children }: { range: string; children: ReactNode }) {
  const [dismissed, setDismissed] = useState("");
  const anchor = useRef({ getBoundingClientRect: () => {
    const selection = window.getSelection();
    return selection?.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : new DOMRect();
  } });
  return <Popover open={!!range && range !== dismissed} onOpenChange={(open) => { if (!open) setDismissed(range); }}>
    <PopoverAnchor virtualRef={anchor} />
    <PopoverContent key={range} side="top" label="Selection formatting" density="compact"
      onOpenAutoFocus={(event) => event.preventDefault()} onCloseAutoFocus={(event) => event.preventDefault()}
      className={styles.floating}>
      <Toolbar gap={0} className={styles.toolbar} aria-label="Selection formatting">{children}</Toolbar>
    </PopoverContent>
  </Popover>;
}
