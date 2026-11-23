import type { ComponentPropsWithRef } from "react";
import styles from "./terminal-output.module.css";

export function TerminalOutput({ className = "", ...props }: ComponentPropsWithRef<"pre">) {
  return <pre tabIndex={0} {...props} className={`${styles.output} ${className}`} />;
}
