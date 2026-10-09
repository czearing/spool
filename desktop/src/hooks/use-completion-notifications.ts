"use client";

import { useEffect, useRef, useState } from "react";
import { createCompletionTracker, type JobCompletion } from "../lib/job-completions";

export function useCompletionNotifications(completed?: readonly JobCompletion[]) {
  const tracker = useRef<ReturnType<typeof createCompletionTracker> | null>(null);
  tracker.current ??= createCompletionTracker();
  const [notifications, setNotifications] = useState<JobCompletion[]>([]);
  useEffect(() => {
    if (!completed) return;
    const fresh = tracker.current!(completed);
    if (fresh.length) setNotifications((items) => [...items, ...fresh]);
  }, [completed]);
  return { notifications, dismiss: (key: string) => setNotifications((items) => items.filter((item) => item.key !== key)) };
}
