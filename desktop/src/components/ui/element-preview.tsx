"use client";

import { useLayoutEffect, useRef } from "react";
import styles from "./drag.module.css";

export function ElementPreview({ element }: { element: HTMLElement }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const clone = element.cloneNode(true);
    if (!(clone instanceof HTMLElement) || !ref.current) return;
    clone.removeAttribute("id"); clone.removeAttribute("data-block-dragging");
    clone.style.transform = ""; clone.style.transition = ""; clone.style.opacity = ""; clone.style.margin = "0";
    clone.querySelectorAll("[id]").forEach((child) => child.removeAttribute("id"));
    ref.current.replaceChildren(clone);
  }, [element]);
  return <div ref={ref} className={styles.preview} inert aria-hidden="true" />;
}
