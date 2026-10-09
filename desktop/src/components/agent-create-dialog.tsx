"use client";

import { useId, useRef, useState, type ComponentProps } from "react";
import dynamic from "../platform/lazy";
import { useCreateAgent, type AgentDraft } from "../hooks/use-create-agent";
import { useModelCatalog } from "../hooks/use-model-settings";
import { AgentSettingsFields, type AgentFields } from "./agent-settings-fields";
import { Dialog } from "./ui/dialog";
import { Input } from "./ui/input";
import { Dropdown, type DropdownOption } from "./ui/dropdown";
import { Button } from "./ui/button";
import { Text } from "./ui/text";
import { Stack } from "./ui/stack";
import { Field } from "./ui/field";
import type { EditorHandle } from "./ui/editor";
import styles from "./agent-create-dialog.module.css";

const Editor = dynamic(() => import("./ui/editor").then((module) => module.Editor), { ssr: false });
type Props = Pick<ComponentProps<typeof Dialog>, "open" | "onOpenChange" | "onCloseAutoFocus">;
export function AgentCreateDialogView({ options, pending, loading, error, onCreate, ...dialog }: Props & {
  options: readonly DropdownOption[]; pending?: boolean; loading?: boolean; error?: string; onCreate: (draft: AgentDraft) => void;
}) {
  const id = useId(), editor = useRef<EditorHandle>(null);
  const [name, setName] = useState(""), [model, setModel] = useState<string | null>(null), [validation, setValidation] = useState("");
  const [fields, setFields] = useState<AgentFields>({ image: null, maxConcurrentRuns: 1 });
  const [imageBusy, setImageBusy] = useState(false);
  const validLimit = fields.maxConcurrentRuns === null || Number.isSafeInteger(fields.maxConcurrentRuns) && fields.maxConcurrentRuns > 0;
  return <Dialog {...dialog} title="Create agent" onOpenChange={(open) => { if (!pending && !imageBusy) dialog.onOpenChange?.(open); }}
    footer={<Button variant="primary" type="submit" form={id} disabled={pending || loading || imageBusy || !validLimit}>{pending ? "Creating..." : "Create agent"}</Button>}>
    <Stack asChild gap={4}><form id={id} onSubmit={(event) => {
      event.preventDefault();
      const prompt = editor.current?.getMarkdown().trim() ?? "";
      if (!prompt) { setValidation("Enter agent instructions."); editor.current?.focus(); return; }
      if (!validLimit || pending || loading || imageBusy) return;
      setValidation("");
      onCreate({ name, prompt, model, image: fields.image, max_concurrent_runs: fields.maxConcurrentRuns });
    }}>
      <Input label="Name" placeholder="researcher" required pattern="[a-z][a-z0-9-]{0,63}" maxLength={64}
        description="Lowercase letters, numbers and hyphens." value={name} disabled={pending}
        onChange={(event) => setName(event.target.value)} />
      <AgentSettingsFields value={fields} disabled={pending} onBusyChange={setImageBusy}
        onChange={(value) => setFields((fields) => ({ ...fields, ...value }))} />
      <Dropdown label="Model" value={model ?? "inherit"} disabled={pending || loading}
        options={[{ value: "inherit", label: "Use project default" }, ...options]}
        onValueChange={(value) => setModel(value === "inherit" ? null : value)} />
      <Field label="Instructions" id={`${id}-instructions`} required>
        <Editor ref={editor} id={`${id}-instructions`} label="Instructions" required presentation="document" blockDragging={false} className={styles.instructions}
          readOnly={pending} onError={(error) => setValidation(error.message)} />
      </Field>
      {(validation || error) && <Text role="alert">{validation || error}</Text>}
    </form></Stack>
  </Dialog>;
}
export function AgentCreateDialog({ project, onCreated, ...dialog }: Props & { project: string; onCreated: (name: string) => void }) {
  const mutation = useCreateAgent(project), catalog = useModelCatalog(!!dialog.open);
  return <AgentCreateDialogView {...dialog} options={catalog.data ?? []} pending={mutation.isPending}
    loading={catalog.isPending} error={mutation.error?.message ?? catalog.error?.message}
    onCreate={(draft) => mutation.mutate(draft, { onSuccess: (agent) => { dialog.onOpenChange?.(false); onCreated(agent.name); } })} />;
}
