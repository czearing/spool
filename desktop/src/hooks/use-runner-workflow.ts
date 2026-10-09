"use client";

import { appFetch } from "../platform/request";


import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isRunnerWorkflow, type RunnerWorkflow } from "../lib/runner-workflow";

async function read(response: Response) {
  const value: unknown = await response.json();
  if (!response.ok) {
    const message = value && typeof value === "object" && "error" in value ? value.error : "Runner request failed.";
    throw new Error(typeof message === "string" ? message : "Runner request failed.");
  }
  if (!isRunnerWorkflow(value)) throw new Error("Invalid runner configuration.");
  return value;
}
export function useRunnerWorkflow(project: string, id: string) {
  const client = useQueryClient(), key = ["runner-workflow", project, id];
  const base = `/api/projects/${encodeURIComponent(project)}/runners/`;
  const query = useQuery({ queryKey: key, enabled: id !== "new", retry: false, refetchOnWindowFocus: false,
    queryFn: ({ signal }) => appFetch(`${base}${encodeURIComponent(id)}`, { signal }).then(read) });
  const mutation = useMutation({ retry: false, networkMode: "always",
    mutationFn: ({ inspection: _inspection, ...value }: RunnerWorkflow) => appFetch(`${base}${value.id}`, {
      method: id === "new" ? "POST" : "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value),
    }).then(read),
    onSuccess: value => {
      client.setQueryData(["runner-workflow", project, value.id], value);
      void client.invalidateQueries({ queryKey: ["runners", project] });
    },
  });
  return { query, mutation };
}
