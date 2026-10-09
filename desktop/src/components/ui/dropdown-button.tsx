"use client";

import { ChevronDown } from "lucide-react";
import type { ComponentPropsWithRef } from "react";
import { Button } from "./button";
import { MenuTrigger } from "./menu";
import { Stack } from "./stack";
import styles from "./dropdown-button.module.css";

type Props = Omit<ComponentPropsWithRef<typeof Button>, "asChild">;

export function DropdownButton({ children, className = "", ...props }: Props) {
  return <MenuTrigger asChild><Stack asChild direction="row" align="center" justify="space-between" gap={2}><Button {...props} className={`${styles.button} ${className}`}>
    {children}<ChevronDown className={styles.icon} aria-hidden="true" />
  </Button></Stack></MenuTrigger>;
}
