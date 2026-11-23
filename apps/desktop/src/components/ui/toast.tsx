"use client";

import { Toast as Primitive, Portal } from "radix-ui";
import { X } from "lucide-react";
import type { ComponentProps, ComponentPropsWithRef } from "react";
import { Button } from "./button";
import { Stack } from "./stack";
import { Grid } from "./grid";
import { Text } from "./text";
import styles from "./toast.module.css";

export function ToastProvider({ children, ...props }: ComponentProps<typeof Primitive.Provider>) {
  return <Primitive.Provider {...props}>
    {children}
    <Portal.Root><Stack asChild gap={3}><Primitive.Viewport className={styles.viewport} label="Notifications ({hotkey})" /></Stack></Portal.Root>
  </Primitive.Provider>;
}

type Props = Omit<ComponentPropsWithRef<typeof Primitive.Root>, "title"> & { title: string; description?: string };

export function Toast({ title, description, children, className = "", ...props }: Props) {
  return <Grid asChild gap={3}><Primitive.Root {...props} className={`${styles.toast} ${className}`}>
    <Stack gap={1} className={styles.body}>
      <Text asChild variant="heading"><Primitive.Title>{title}</Primitive.Title></Text>
      {description && <Text asChild tone="secondary"><Primitive.Description>{description}</Primitive.Description></Text>}
    </Stack>
    <Primitive.Close asChild><Button className={styles.close} aria-label="Dismiss notification"><X className={styles.icon} aria-hidden="true" /></Button></Primitive.Close>
    {children && <Stack direction="row" gap={2} wrap className={styles.actions}>{children}</Stack>}
  </Primitive.Root></Grid>;
}

export function ToastAction({ children, ...props }: Omit<ComponentPropsWithRef<typeof Primitive.Action>, "asChild">) {
  return <Primitive.Action {...props} asChild><Button>{children}</Button></Primitive.Action>;
}
