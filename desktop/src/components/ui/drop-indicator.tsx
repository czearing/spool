"use client";

import { useLayoutEffect, type ComponentPropsWithRef } from "react";
import { createPortal } from "react-dom";
import { autoUpdate, offset, size, useFloating } from "@floating-ui/react-dom";
import { popupPlacement } from "./primitive-tokens";
import styles from "./drag.module.css";

type Direction = { orientation?: "horizontal" | "vertical"; placement?: "before" | "after" };
type Target = { anchor: HTMLElement; rect?: never } | { anchor?: never; rect?: Pick<DOMRect, "x" | "y" | "width" | "height"> };
function Indicator({ orientation = "horizontal", className = "", ...props }: ComponentPropsWithRef<"div"> & Direction) {
  return <div {...props} className={`${styles.indicator} ${className}`} data-orientation={orientation} aria-hidden="true" data-drop-indicator />;
}
function AnchoredIndicator({ anchor, placement = "before", orientation = "horizontal" }: Direction & { anchor: HTMLElement }) {
  const side = orientation === "horizontal" ? (placement === "before" ? "top-start" : "bottom-start")
    : (placement === "before" ? "left-start" : "right-start");
  const { refs, floatingStyles } = useFloating({ placement: side,
    strategy: "fixed", whileElementsMounted: autoUpdate,
    middleware: [offset(popupPlacement.sideOffset), size({ apply: ({ rects, elements }) => {
      const axis = orientation === "horizontal" ? "width" : "height";
      elements.floating.style[axis] = `${rects.reference[axis]}px`;
    } })] });
  useLayoutEffect(() => { refs.setReference(anchor); }, [anchor, refs]);
  return createPortal(<Indicator ref={refs.setFloating} style={floatingStyles} orientation={orientation} />, anchor.ownerDocument.body);
}
export function DropIndicator({ anchor, rect, orientation = "horizontal", placement = "before" }: Direction & Target) {
  if (anchor) return <AnchoredIndicator {...{ anchor, orientation, placement }} />;
  if (rect) return createPortal(<Indicator orientation={orientation} style={{
    position: "fixed", left: rect.x, top: rect.y, ...(orientation === "horizontal" ? { width: rect.width } : { height: rect.height }),
  }} />, document.body);
  return <Indicator orientation={orientation} data-placement={placement} className={styles.inlineIndicator} />;
}
