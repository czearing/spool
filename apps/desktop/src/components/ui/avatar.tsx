"use client";

import { Avatar as Primitive } from "radix-ui";
import type { ComponentPropsWithRef } from "react";
import { Text } from "./text";
import styles from "./avatar.module.css";

type Props = Omit<ComponentPropsWithRef<typeof Primitive.Root>, "children" | "asChild"> & {
  name: string; fallback: string; src?: string; size?: "small" | "medium" | "large";
};

export function Avatar({ name, fallback, src, size = "medium", className = "", ...props }: Props) {
  return (
    <Text asChild variant="meta"><Primitive.Root {...props} role="img" aria-label={name}
      className={`${styles.avatar} ${styles[size]} ${className}`}>
      <Primitive.Image src={src} alt="" className={styles.image} decoding="async" />
      <Primitive.Fallback className={styles.fallback}>{fallback}</Primitive.Fallback>
    </Primitive.Root></Text>
  );
}
