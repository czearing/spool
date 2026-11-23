import type { ComponentPropsWithRef } from "react";
import styles from "./callout.module.css";

export function Callout({ className = "", ...props }: ComponentPropsWithRef<"aside">) {
  return <aside role="note" {...props} className={`${styles.callout} ${className}`} />;
}
// Editors own their child DOM; this adapter shares the surface without a second React owner.
export function createCalloutDOM(document: Document) {
  const element = document.createElement("aside");
  element.className = styles.callout; element.setAttribute("role", "note");
  return element;
}
