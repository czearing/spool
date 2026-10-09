import { appFetch } from "../platform/request";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "../platform/navigation";
import { taskRevision, type SpoolItem } from "../lib/spool-model";
import type { ArchivedSpoolItem } from "../lib/spool-archive";

export function useArchiveTasks(project: string, items: SpoolItem[], archived: readonly ArchivedSpoolItem[]) {
  const router = useRouter();
  const client = useQueryClient();
  const [optimistic, setOptimistic] = useState<SpoolItem[]>([]);
  useEffect(() => {
    const current = new Set(items.map(taskRevision));
    setOptimistic((previous) => previous.filter((item) => current.has(taskRevision(item))));
  }, [items]);
  const mutation = useMutation({
    retry: false, networkMode: "always",
    onMutate: (status: "completed" | "failed") => {
      const previous = optimistic;
      setOptimistic((current) => [...current, ...items.filter((item) => item.status === status)]);
      return previous;
    },
    mutationFn: async (status: "completed" | "failed") => {
      const response = await appFetch(`/api/projects/${encodeURIComponent(project)}/tasks/archive`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }), signal: AbortSignal.timeout(5000),
      }).catch((cause) => { throw new Error("Could not confirm archiving. Refresh before retrying.", { cause }); });
      const result: unknown = await response.json();
      if (!result || typeof result !== "object") throw new Error("Invalid archive response.");
      if (!response.ok) throw new Error("error" in result && typeof result.error === "string" ? result.error : "Could not archive tasks.");
      if (!("archived" in result) || typeof result.archived !== "number" || !Number.isSafeInteger(result.archived) || result.archived < 0) {
        throw new Error("Invalid archive result.");
      }
      return result.archived;
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["project-live", project] });
      router.refresh();
    },
    onError: (_error, _status, previous) => { setOptimistic(previous ?? []); router.refresh(); },
  });
  const board = useMemo(() => {
    const revisions = new Set(optimistic.map(taskRevision));
    const pending = optimistic.filter((item) => !archived.some((entry) => entry.key === `task:${item.id}`));
    return { items: items.filter((item) => !revisions.has(taskRevision(item))),
      archived: [...pending.map((item) => ({ ...item, key: `task:${item.id}`, updatedAt: item.updatedAt ?? null })), ...archived] };
  }, [items, archived, optimistic]);
  return { ...board, archive: mutation.mutateAsync, pending: mutation.isPending };
}
