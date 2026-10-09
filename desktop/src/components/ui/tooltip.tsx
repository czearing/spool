"use client";

import { Tooltip as Primitive } from "radix-ui";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { Text } from "./text";
import { popupPlacement } from "./primitive-tokens";
import styles from "./tooltip.module.css";

export const TooltipProvider = Primitive.Provider;

type Props = Omit<ComponentProps<typeof Primitive.Root>, "children"> & {
  children: ReactElement; content: ReactNode; side?: ComponentProps<typeof Primitive.Content>["side"];
};

export function Tooltip({ children, content, side = "top", ...props }: Props) {
  return <Primitive.Root {...props}>
    <Primitive.Trigger asChild>{children}</Primitive.Trigger>
    <Primitive.Portal><Text asChild><Primitive.Content side={side} {...popupPlacement} className={styles.content}>
      {content}
    </Primitive.Content></Text></Primitive.Portal>
  </Primitive.Root>;
}
