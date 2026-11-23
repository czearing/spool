"use client";

import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { seedItems } from "../lib/seed";
import { applyCommand, type Command, type WorkItem } from "../lib/work-items";

const queryKey = ["work-items"] as const;

export function WorkItemsProvider({ children, items = seedItems }: { children: ReactNode; items?: WorkItem[] }) {
  const [client] = useState(() => {
    const client = new QueryClient();
    client.setQueryData(queryKey, items);
    return client;
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

export function useWorkItems() {
  const client = useQueryClient();
  const { data: items = [] } = useQuery<WorkItem[]>({ queryKey, enabled: false });
  const { mutate: dispatch, mutateAsync: execute, error, variables } = useMutation({
    scope: { id: "work-items" },
    mutationFn: async (command: Command) => {
      const current = client.getQueryData<WorkItem[]>(queryKey);
      if (!current) throw new Error("The board has not been initialized.");
      return applyCommand(current, command);
    },
    onSuccess: (result) => client.setQueryData(queryKey, result),
  });
  return { items, dispatch, execute, error: variables?.type === "create" ? null : error };
}
