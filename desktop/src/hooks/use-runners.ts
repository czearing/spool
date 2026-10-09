"use client";

import { AppEventSource } from "../platform/event-source";

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { isRunnerSnapshot, type RunnerSnapshot } from "../lib/runners";

export function useRunners(project: string) {
  const client = useQueryClient(), [attempt, retry] = useState(0), [error, setError] = useState<Error | null>(null);
  const query = useQuery<RunnerSnapshot>({ queryKey: ["runners", project], enabled: false, gcTime: 0 });
  useEffect(() => {
    const source = new AppEventSource(`/api/projects/${encodeURIComponent(project)}/runners`);
    const unavailable = () => setError(new Error("Runner status is unavailable. Connection and activity could not be verified."));
    source.onmessage = event => {
      try {
        const value: unknown = JSON.parse(event.data);
        if (!isRunnerSnapshot(value)) throw new Error("Invalid runner status response.");
        client.setQueryData(["runners", project], value);
        setError(null);
      } catch { unavailable(); source.close(); }
    };
    source.addEventListener("unavailable", unavailable);
    source.onerror = unavailable;
    return () => source.close();
  }, [project, client, attempt]);
  return { data: query.data, isPending: query.isPending, error, refetch: () => retry(value => value + 1) };
}
