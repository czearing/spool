"use client";

import { useId, type ComponentProps } from "react";
import { useCreateTask } from "../hooks/use-create-task";
import { TaskCreateForm } from "./task-create-form";
import { Dialog, DialogClose } from "./ui/dialog";
import { Button } from "./ui/button";

export default function NewTaskDialog({ project, agents, onCreated, onOpenChange, onCloseAutoFocus }: {
  project: string; agents: string[]; onCreated: (message: string) => void; onOpenChange: (open: boolean) => void;
  onCloseAutoFocus?: ComponentProps<typeof Dialog>["onCloseAutoFocus"];
}) {
  const formId = useId(), mutation = useCreateTask(project, (task) => onCreated(task.notice));
  return <Dialog open title="New task" presentation="composer" onOpenChange={onOpenChange} onCloseAutoFocus={onCloseAutoFocus}>
    <TaskCreateForm id={formId} agents={agents} pending={mutation.isPending} error={mutation.error?.message}
      actions={<><DialogClose asChild><Button>{mutation.isPending ? "Close" : "Cancel"}</Button></DialogClose>
        <Button variant="primary" type="submit" form={formId} disabled={mutation.isPending || !agents.length}>
          {mutation.isPending ? "Submitting..." : "Create"}
        </Button></>}
      onSubmit={(draft) => mutation.mutate(draft)} />
  </Dialog>;
}
