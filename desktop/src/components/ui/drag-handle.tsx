"use client";

import { useLayoutEffect, type ComponentPropsWithRef } from "react";
import { createPortal } from "react-dom";
import { autoUpdate, offset, useFloating } from "@floating-ui/react-dom";
import { GripVertical } from "lucide-react";
import { Button } from "./button";
import { popupPlacement } from "./primitive-tokens";
import styles from "./drag.module.css";

export function DragHandle({ anchor, className = "", ...props }: ComponentPropsWithRef<typeof Button> & { anchor: HTMLElement }) {
  const { refs, floatingStyles } = useFloating({ placement: "left-start", strategy: "fixed", whileElementsMounted: autoUpdate,
    middleware: [offset(({ rects }) => ({
      mainAxis: popupPlacement.sideOffset,
      crossAxis: (Math.min(parseFloat(getComputedStyle(anchor).lineHeight) || rects.reference.height, rects.reference.height) - rects.floating.height) / 2,
    }))] });
  useLayoutEffect(() => { refs.setReference(anchor); }, [anchor, refs]);
  return createPortal(<div ref={refs.setFloating} style={floatingStyles} data-drag-handle className={styles.handlePosition}>
    <Button {...props} className={`${styles.handle} ${className}`}><GripVertical aria-hidden="true" /></Button>
  </div>, anchor.ownerDocument.body);
}
