"use client";

import { Slot } from "radix-ui";
import type { ComponentPropsWithRef } from "react";
import { Text } from "./text";
import styles from "./card.module.css";

type Props = ComponentPropsWithRef<"div"> & { asChild?: boolean };

export function Card({ asChild = false, className = "", ...props }: Props) {
  const Component = asChild ? Slot.Root : "div";
  return <Text asChild><Component className={`${styles.card} ${className}`} {...props} /></Text>;
}
