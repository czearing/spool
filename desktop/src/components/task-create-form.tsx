"use client";

import { useId, useRef, useState, type ReactNode } from "react";
import { Bot } from "lucide-react";
import type { TaskDraft } from "../lib/task-submission";
import { Editor, type EditorHandle } from "./ui/editor";
import { Input } from "./ui/input";
import { Dropdown } from "./ui/dropdown";
import { Field } from "./ui/field";
import { Stack } from "./ui/stack";
import { Text } from "./ui/text";
import { Divider } from "./ui/divider";
import styles from "./task-create-form.module.css";

export function TaskCreateForm({ id, agents, onSubmit, pending, error, actions }: {
  id: string; agents: readonly string[]; onSubmit: (draft: TaskDraft) => void;
  pending: boolean; error?: string; actions?: ReactNode;
}) {
  const instructionsId = useId(), editor = useRef<EditorHandle>(null);
  const [validation, setValidation] = useState("");
  return <Stack asChild gap={4}><form id={id} className={styles.composer} aria-busy={pending} onSubmit={(event) => {
    event.preventDefault(); if (pending) return;
    const fields = new FormData(event.currentTarget), prompt = editor.current?.getMarkdown().trim() ?? "";
    if (!prompt) { setValidation("Enter instructions."); editor.current?.focus(); return; }
    setValidation("");
    onSubmit({ title: String(fields.get("title") ?? ""), agent: String(fields.get("agent") ?? ""), prompt });
  }}>
    <Input label="Title" labelHidden placeholder="Task title" className={styles.title} name="title" required maxLength={500} disabled={pending} autoComplete="off" />
    <Field id={instructionsId} label="Instructions" labelHidden required>
      <Editor ref={editor} id={instructionsId} label="Instructions" placeholder="Instructions..." required readOnly={pending}
        presentation="document" blockDragging={false} className={styles.instructions} onError={(cause) => setValidation(cause.message)} />
    </Field>
    {(validation || error) && <Text role="alert">{validation || error}</Text>}
    {!agents.length && <Text role="alert">No agents configured for this project.</Text>}
    <Divider className={styles.divider} />
    <Stack direction="row" justify="space-between" align="center" gap={2} className={styles.footer}>
      <div className={styles.assignee}><Dropdown label="Agent" labelHidden name="agent" required density="compact" icon={<Bot />}
        disabled={pending || !agents.length} placeholder="Agent" options={agents.map((agent) => ({ value: agent, label: agent }))} /></div>
      <Stack direction="row" gap={2} className={styles.actions}>{actions}</Stack>
    </Stack>
  </form></Stack>;
}
