import { useState } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Stack } from "./ui/stack";
import styles from "./board-controls.module.css";

export function BoardComposer({ statusLabel, onCreate, onCancel }: {
  statusLabel: string; onCreate: (title: string) => Promise<void>; onCancel: () => void;
}) {
  const [title, setTitle] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  return <Stack asChild gap={2}><form className={styles.composer} aria-label={`New item in ${statusLabel}`}
    onKeyDown={(event) => {
      if (event.key === "Escape" && !pending && !event.nativeEvent.isComposing) { event.preventDefault(); onCancel(); }
    }}
    onSubmit={async (event) => {
      event.preventDefault();
      if (pending) return;
      setPending(true); setError("");
      try { await onCreate(title); }
      catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
      finally { setPending(false); }
    }}>
    <Input label="Task title" labelHidden density="compact" autoFocus required placeholder="Task title"
      value={title} disabled={pending} error={error} onChange={(event) => setTitle(event.target.value)} />
    <Stack direction="row" gap={2} wrap className={styles.composerActions}>
      <Button type="submit" variant="primary" disabled={pending}>{pending ? "Adding..." : "Add task"}</Button>
      <Button onClick={onCancel} disabled={pending}>Cancel</Button>
    </Stack>
  </form></Stack>;
}
