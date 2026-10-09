"use client";

import { ImagePicker } from "./ui/image-picker";
import { Checkbox } from "./ui/checkbox";
import { Input } from "./ui/input";
import { Stack } from "./ui/stack";
import styles from "./agent-settings-fields.module.css";

export type AgentFields = { image: string | null; maxConcurrentRuns: number | null };
export function AgentSettingsFields({ value, onChange, disabled, onBusyChange }: {
  value: AgentFields; onChange: (value: Partial<AgentFields>) => void; disabled?: boolean; onBusyChange?: (busy: boolean) => void;
}) {
  return <Stack gap={4}>
    <ImagePicker value={value.image} disabled={disabled} onChange={(image) => onChange({ image })} onBusyChange={onBusyChange} />
    <Input label="Max concurrent runs" type="number" min={1} step={1}
      disabled={disabled || value.maxConcurrentRuns === null}
      placeholder={value.maxConcurrentRuns === null ? "Unlimited" : undefined}
      value={value.maxConcurrentRuns === null || Number.isNaN(value.maxConcurrentRuns) ? "" : value.maxConcurrentRuns}
      endAction={<span className={styles.unlimited}><Checkbox label="No limit" checked={value.maxConcurrentRuns === null} disabled={disabled}
        onCheckedChange={(checked) => onChange({ maxConcurrentRuns: checked ? null : 1 })} /></span>}
      onChange={(event) => onChange({ maxConcurrentRuns: event.target.valueAsNumber })} />
  </Stack>;
}
