"use client";

import { useId, type ComponentProps } from "react";
import { useCreateProject } from "../hooks/use-create-project";
import { browseLocalPath } from "../lib/local-file-picker";
import { Button } from "./ui/button";
import { Dialog, DialogClose } from "./ui/dialog";
import { Input } from "./ui/input";
import { FilePicker } from "./ui/file-picker";
import { Stack } from "./ui/stack";
import { Text } from "./ui/text";

export default function CreateProjectDialog({ onCreated, onOpenChange, onCloseAutoFocus }: {
  onCreated: (id: string) => void; onOpenChange: (open: boolean) => void;
  onCloseAutoFocus?: ComponentProps<typeof Dialog>["onCloseAutoFocus"];
}) {
  const formId = useId();
  const { mutate, isPending, error } = useCreateProject(onCreated);
  return <Dialog open title="Create project" description="Connect a project to an existing local Spool folder."
    onOpenChange={(open) => { if (!isPending) onOpenChange(open); }} onCloseAutoFocus={onCloseAutoFocus}
    footer={<><DialogClose asChild><Button disabled={isPending}>Cancel</Button></DialogClose>
      <Button type="submit" form={formId} variant="primary" disabled={isPending}>{isPending ? "Creating..." : "Create project"}</Button></>}>
    <Stack asChild gap={4}><form id={formId} aria-busy={isPending} onSubmit={(event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      mutate({ name: String(data.get("name") ?? ""), root: String(data.get("root") ?? "") });
    }}>
      <Input label="Project name" name="name" required maxLength={80} autoComplete="off" disabled={isPending} />
      <FilePicker label="Spool folder" name="root" kind="folder" onBrowse={(signal) => browseLocalPath("folder", signal)} required maxLength={4096}
        placeholder="C:\Code\my-project\spool" description="Absolute path to the folder containing queues. Existing task files are never changed."
        disabled={isPending} />
      {error && <Text role="alert">{error.message}</Text>}
    </form></Stack>
  </Dialog>;
}
