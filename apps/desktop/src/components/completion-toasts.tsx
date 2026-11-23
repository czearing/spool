"use client";

import type { JobCompletion } from "../lib/job-completions";
import { Toast, ToastProvider } from "./ui/toast";

export function CompletionToasts({ notifications, onDismiss }: { notifications: readonly JobCompletion[]; onDismiss: (key: string) => void }) {
  return <ToastProvider>
    {notifications.slice(0, 3).map((item) => <Toast key={item.key} title="Job completed"
      description={`${item.agent ? `${item.agent}: ` : ""}${item.title}`}
      onOpenChange={(open) => { if (!open) onDismiss(item.key); }} />)}
  </ToastProvider>;
}
