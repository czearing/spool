"use client";

import { useEffect, useRef, useState } from "react";
import { createCompletionTracker, isJobCompletion, type JobCompletion } from "../lib/job-completions";
import { AppEventSource } from "../platform/event-source";

export function useCompletionNotifications(project: string, activeAgent?: string) {
  const tracker = useRef<ReturnType<typeof createCompletionTracker> | null>(null);
  tracker.current ??= createCompletionTracker();
  const viewedAgent = useRef(activeAgent);
  viewedAgent.current = activeAgent;
  const [notifications, setNotifications] = useState<JobCompletion[]>([]);
  useEffect(() => {
    const source = new AppEventSource(`/api/projects/${encodeURIComponent(project)}/completions`);
    source.onmessage = event => {
      const completed: unknown = JSON.parse(event.data);
      if (!Array.isArray(completed) || !completed.every(isJobCompletion)) throw new Error("Invalid job completions.");
      const fresh = tracker.current!(completed, viewedAgent.current);
      if (fresh.length) setNotifications(items => [...items, ...fresh]);
    };
    return () => source.close();
  }, [project]);
  useEffect(() => {
    if (activeAgent) setNotifications(items => items.filter(item => item.agent !== activeAgent));
  }, [activeAgent]);
  return { notifications: activeAgent ? notifications.filter(item => item.agent !== activeAgent) : notifications,
    dismiss: (key: string) => setNotifications(items => items.filter(item => item.key !== key)) };
}
