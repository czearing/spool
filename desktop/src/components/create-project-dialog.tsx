"use client";

import { useId, useState, type ComponentProps } from "react";
import { useCreateProject } from "../hooks/use-create-project";
import { Button } from "./ui/button";
import { Dialog, DialogClose } from "./ui/dialog";
import { Input } from "./ui/input";
import { Stack } from "./ui/stack";
import { Text } from "./ui/text";

export default function CreateProjectDialog({ onCreated, onOpenChange, onCloseAutoFocus }: {
  onCreated: (id: string) => void; onOpenChange: (open: boolean) => void;
  onCloseAutoFocus?: ComponentProps<typeof Dialog>["onCloseAutoFocus"];
}) {
  const formId = useId();
  const [name, setName] = useState("");
  const { mutate, isPending, error } = useCreateProject(onCreated);
  return <Dialog open title="Add project" description="Give your project a name."
    onOpenChange={(open) => { if (!isPending) onOpenChange(open); }} onCloseAutoFocus={onCloseAutoFocus}
    footer={<><DialogClose asChild><Button disabled={isPending}>Cancel</Button></DialogClose>
      <Button type="submit" form={formId} variant="primary" disabled={isPending || !name.trim()}>{isPending ? "Adding..." : "Add project"}</Button></>}>
    <Stack asChild gap={4}><form id={formId} aria-busy={isPending} onSubmit={(event) => {
      event.preventDefault();
      mutate({ name });
    }}>
      <Input label="Project name" name="name" value={name} required maxLength={80} autoComplete="off" disabled={isPending}
        onChange={(event) => setName(event.target.value)} />
      {error && <Text role="alert">{error.message}</Text>}
    </form></Stack>
  </Dialog>;
}
