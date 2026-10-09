"use client";

import { Dialog as Primitive, VisuallyHidden } from "radix-ui";
import { X } from "lucide-react";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { Button } from "./button";
import { Stack } from "./stack";
import { Grid } from "./grid";
import { Text } from "./text";
import styles from "./dialog.module.css";

type Props = ComponentProps<typeof Primitive.Root> & Pick<ComponentProps<typeof Primitive.Content>, "onCloseAutoFocus"> & {
  trigger?: ReactElement; title: string; description?: string; footer?: ReactNode; presentation?: "default" | "composer" | "conversation" | "inspector" | "node";
  container?: HTMLElement | null;
};

export const DialogClose = Primitive.Close;

export function Dialog({ trigger, title, description, children, footer, presentation = "default", onCloseAutoFocus, container, modal = true, ...props }: Props) {
  const heading = <Stack gap={2} className={styles.heading}>
    <Text asChild variant="heading"><Primitive.Title className={styles.title}>{title}</Primitive.Title></Text>
    {description && <Text asChild tone="secondary"><Primitive.Description className={styles.description}>{description}</Primitive.Description></Text>}
  </Stack>;
  return <Primitive.Root {...props} modal={modal}>
    {trigger && <Primitive.Trigger asChild>{trigger}</Primitive.Trigger>}
    <Primitive.Portal container={container}>
      <Primitive.Overlay className={styles.overlay} data-presentation={presentation} />
      <Grid asChild gap={["conversation", "node"].includes(presentation) ? 0 : 4}><Primitive.Content className={styles.content} data-presentation={presentation} data-modal={modal} onCloseAutoFocus={onCloseAutoFocus} {...(description ? {} : { "aria-describedby": undefined })}>
        {["composer", "node"].includes(presentation) ? <VisuallyHidden.Root asChild>{heading}</VisuallyHidden.Root> : heading}
        <div className={styles.body}>{children}</div>
        {footer && <Stack direction="row" justify="end" gap={2} wrap className={styles.footer}>{footer}</Stack>}
        <Primitive.Close asChild><Button className={styles.close} aria-label="Close dialog"><X className={styles.icon} aria-hidden="true" /></Button></Primitive.Close>
      </Primitive.Content></Grid>
    </Primitive.Portal>
  </Primitive.Root>;
}
