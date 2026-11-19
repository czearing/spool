"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { appFetch } from "../platform/request";
import type { OperatorMessage } from "../lib/task-conversation";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { Stack } from "./ui/stack";
import { Text } from "./ui/text";

type Choice = { id: string; message: OperatorMessage; decision: "retry" | "dismiss" };
export function MessageDeliveryRecovery({ project, task, messages, available, onResolved }: {
  project: string; task: string; messages: OperatorMessage[]; available: boolean; onResolved: () => void;
}) {
  const [choice, setChoice] = useState<Choice>();
  const client = useQueryClient();
  const mutation = useMutation({ retry: false, networkMode: "always", mutationFn: async (input: Choice) => {
    const response = await appFetch(`/api/projects/${encodeURIComponent(project)}/tasks/${encodeURIComponent(task)}/conversation`, {
      method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(20000),
      body: JSON.stringify({ id: input.id, messageId: input.message.id, decision: input.decision }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "Message recovery could not be confirmed.");
    if (body.id !== input.id || body.state !== "accepted") throw new Error("Message recovery was not confirmed. Retry the same decision.");
  }, onSuccess: () => {
    setChoice(undefined); onResolved();
    void client.invalidateQueries({ queryKey: ["project-live", project] });
  } });
  const uncertain = messages.filter(message => message.status === "delivery_uncertain");
  if (!uncertain.length) return null;
  const select = (message: OperatorMessage, decision: Choice["decision"]) => {
    mutation.reset(); setChoice({ id: crypto.randomUUID(), message, decision });
  };
  return <Stack gap={2} aria-label="Unconfirmed message delivery">
    <Text>Delivery of an earlier message is unconfirmed. Later replies do not confirm it. Nothing is automatically resent.</Text>
    {!available && <Text role="status">Update the running Spool daemon to resolve these messages.</Text>}
    {uncertain.map(message => <Stack gap={2} key={message.id}>
      <Text>{message.text.length > 300 ? `${message.text.slice(0, 300)}...` : message.text}</Text>
      <Stack direction="row" gap={2}>
        <Button disabled={!available || mutation.isPending} onClick={() => select(message, "retry")}>Resend message</Button>
        <Button disabled={!available || mutation.isPending} onClick={() => select(message, "dismiss")}>Leave unsent</Button>
      </Stack>
    </Stack>)}
    {choice && <Dialog open title={choice.decision === "retry" ? "Resend uncertain message?" : "Leave message unsent?"}
      description={choice.decision === "retry"
        ? "The provider may already have received this message. Resending can repeat work or side effects. Only this message will be resent in the same conversation."
        : "Keep this message in history without resending it or claiming it was delivered. No task will be started."}
      onOpenChange={open => { if (!open && !mutation.isPending) setChoice(undefined); }}
      footer={<><Button disabled={mutation.isPending} onClick={() => setChoice(undefined)}>Cancel</Button>
        <Button variant="primary" disabled={mutation.isPending} onClick={() => mutation.mutate(choice)}>
          {mutation.isPending ? "Confirming..." : choice.decision === "retry" ? "Confirm resend" : "Confirm leave unsent"}
        </Button></>}>
      <Stack gap={2}><Text>{choice.message.text}</Text>
        {mutation.error && <Text role="alert">{mutation.error.message}</Text>}</Stack>
    </Dialog>}
  </Stack>;
}
