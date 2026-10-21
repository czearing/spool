"use client";

import { AppEventSource } from "../platform/event-source";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { isRunnerCatalog, type RunnerCatalog } from "../lib/runners";

export function useRunnerCatalog(project: string, initial?: RunnerCatalog) {
  const client = useQueryClient(), [attempt, retry] = useState(0), [error, setError] = useState<Error | null>(null);
  const query = useQuery<RunnerCatalog>({ queryKey: ["runner-catalog", project], enabled: false, initialData: initial });
  useEffect(() => {
    const source = new AppEventSource(`/api/projects/${encodeURIComponent(project)}/runners`);
    const unavailable = () => setError(new Error("Runner list is unavailable."));
    source.onmessage = event => {
      try {
        const value: unknown = JSON.parse(event.data);
        if (!isRunnerCatalog(value)) throw new Error("Invalid runner catalog response.");
        client.setQueryData(["runner-catalog", project], value); setError(null);
      } catch { unavailable(); source.close(); }
    };
    source.addEventListener("unavailable", unavailable);
    source.onerror = unavailable;
    return () => source.close();
  }, [project, client, attempt]);
  return { data: query.data, error: query.data?.error ? new Error(query.data.error) : error,
    refetch: () => retry(value => value + 1) };
}
