"use client";

import { useEffect, useState, type ComponentProps } from "react";
import { Dialog } from "./ui/dialog";
import TaskChat from "./task-chat";
import { useProjectLive } from "./project-live-provider";

export default function TaskChatDialog({ project, task, onClose, onCloseAutoFocus }: {
  project: string; task: { id: string; title: string; agent?: string };
  onClose: () => void; onCloseAutoFocus: ComponentProps<typeof Dialog>["onCloseAutoFocus"];
}) {
  const [details, setDetails] = useState(task);
  const { setConversationAgent } = useProjectLive();
  useEffect(() => {
    setConversationAgent(details.agent);
    return () => setConversationAgent(undefined);
  }, [details.agent, setConversationAgent]);
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }} title={details.title}
    description={details.agent ?? "Agent"}
    presentation="conversation" onCloseAutoFocus={onCloseAutoFocus}>
    <TaskChat key={task.id} project={project} task={task.id} onDetailsChange={setDetails} />
  </Dialog>;
}
