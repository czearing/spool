"use client";

import type { ComponentProps } from "react";
import { File, FolderOpen, X } from "lucide-react";
import { useFilePicker } from "../../hooks/use-file-picker";
import { Button } from "./button";
import { Input } from "./input";
import { Stack } from "./stack";
import styles from "./file-picker.module.css";

type Props = Omit<ComponentProps<typeof Input>, "value" | "defaultValue" | "onChange" | "type" | "endAction"> & {
  kind?: "file" | "folder"; value?: string; defaultValue?: string;
  onValueChange?: (value: string) => void;
  onBrowse: (signal: AbortSignal) => Promise<string | null>;
};

export function FilePicker({ kind = "file", value, defaultValue, onValueChange, onBrowse, disabled, readOnly, error, ...props }: Props) {
  const picker = useFilePicker({ value, defaultValue, onValueChange, onBrowse });
  const Icon = picker.pending ? X : kind === "folder" ? FolderOpen : File;
  return <Input {...props} value={picker.value} disabled={disabled} readOnly={readOnly || picker.pending}
    autoComplete="off" spellCheck={false} error={error ?? picker.error} aria-busy={picker.pending}
    onChange={(event) => picker.setValue(event.target.value)}
    endAction={<Stack asChild direction="row" align="center" gap={2}><Button className={styles.browse} disabled={disabled || readOnly}
      aria-label={picker.pending ? `Cancel choosing ${props.label}` : `Browse for ${props.label}`} onClick={picker.pending ? picker.cancel : picker.browse}>
      <Icon aria-hidden="true" />{picker.pending ? "Cancel" : "Browse"}
    </Button></Stack>} />;
}
