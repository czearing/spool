"use client";

import { useRef } from "react";
import { Camera } from "lucide-react";
import { useImageUpload } from "../../hooks/use-image-upload";
import { Avatar } from "./avatar";
import { Button } from "./button";
import { Stack } from "./stack";
import { Text } from "./text";
import styles from "./image-picker.module.css";

export function ImagePicker({ value, onChange, disabled, onBusyChange }: {
  value: string | null; onChange: (value: string | null) => void; disabled?: boolean; onBusyChange?: (busy: boolean) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const { busy, error, upload, remove } = useImageUpload(onChange, onBusyChange);
  const label = value ? "Change image" : "Upload image";
  return <Stack gap={2}>
    <Stack direction="row" align="center" gap={4}>
      <Button className={styles.preview} aria-label={busy ? "Uploading image" : label} title={label}
        disabled={disabled || busy} onClick={() => input.current?.click()}>
        <Avatar name="Agent image" fallback="A" src={value ?? undefined} size="large" />
        <Camera className={styles.camera} aria-hidden="true" />
      </Button>
      <Stack gap={1}>
        {value && <Button className={styles.action} disabled={disabled || busy} onClick={remove}>Remove image</Button>}
        <Text variant="meta" tone="muted">JPG, PNG or WebP. Up to 5 MB.</Text>
      </Stack>
      <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" aria-label="Agent image file" hidden
        disabled={disabled || busy} onChange={(event) => { void upload(event.target.files?.[0]); event.target.value = ""; }} />
    </Stack>
    {error && <Text role="alert" variant="meta">{error}</Text>}
  </Stack>;
}
