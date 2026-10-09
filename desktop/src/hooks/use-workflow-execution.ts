"use client";

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { WorkflowExecutionApi } from "../lib/workflow-executions";

export function useWorkflowExecution(api: WorkflowExecutionApi | undefined, revision: string) {
  const [input, setInput] = useState("{}"), [selected, setSelected] = useState("");
  const list = useQuery({ queryKey: ["workflow-runs", api?.webhookUrl], enabled: !!api && !!revision, retry: false,
    queryFn: ({ signal }) => api!.list(signal) });
  const execution = useQuery({ queryKey: ["workflow-run", api?.webhookUrl, selected], enabled: !!api && !!selected, retry: false,
    queryFn: ({ signal }) => api!.read(selected, signal),
    refetchInterval: query => ["queued", "running"].includes(query.state.data?.status || "") ? 1000 : false });
  const mutation = useMutation({ retry: false, networkMode: "always",
    mutationFn: () => {
      if (!api) throw new Error("Execution is unavailable.");
      return api.run(JSON.parse(input), revision, crypto.randomUUID());
    },
    onSuccess: result => { setSelected(result.id); void list.refetch(); } });
  return { input, setInput, selected, setSelected, list: list.data || [], execution: execution.data,
    error: mutation.error || execution.error || list.error,
    active: mutation.isPending || ["queued", "running"].includes(execution.data?.status || ""),
    run: () => mutation.mutate(),
    refresh: () => { void list.refetch(); if (selected) void execution.refetch(); } };
}
export type WorkflowExecutionState = ReturnType<typeof useWorkflowExecution>;
