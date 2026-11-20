"use client";

import dynamic from "../platform/lazy";
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { useBoardControls } from "../hooks/use-board-controls";
import { useArchiveTasks } from "../hooks/use-archive-tasks";
import { ColumnArchiveMenu } from "./column-archive-menu";
import { ArchivedTasks } from "./archived-tasks";
import type { ArchivedSpoolItem } from "../lib/spool-archive";
import { spoolStatuses, type SpoolItem } from "../lib/spool-model";
import type { Status } from "../lib/work-items";
import { preparationLabels } from "../lib/task-preparation";
import { BoardSnapshot, type OpenTask } from "./board-view";
import { BoardToolbar } from "./board-toolbar";
import { Text } from "./ui/text";
import { TooltipProvider } from "./ui/tooltip";
import { useProjectLive } from "./project-live-provider";
import styles from "./board-controls.module.css";

const NewTaskDialog = dynamic(() => import("./new-task-dialog"));
const TaskChatDialog = dynamic(() => import("./task-chat-dialog"));
const labels: Record<Status, string> = { backlog: "Incoming", "in-progress": "In progress", completed: "Completed", blocked: "Failed", superseded: "Superseded", waiting: "Blocked" };
const tones = { incoming: "backlog", in_progress: "in-progress", completed: "completed", failed: "blocked", superseded: "superseded", blocked: "waiting" } as const;
const emptyArchive: readonly ArchivedSpoolItem[] = [];
export function ProjectBoard({ project, items: initialItems, archived = emptyArchive, agents, footer }: {
  project: string; items: SpoolItem[]; archived?: readonly ArchivedSpoolItem[]; agents: string[]; footer?: ReactNode;
}) {
  const archive = useArchiveTasks(project, initialItems, archived), items = archive.items;
  const { data, error } = useProjectLive();
  const configured = data?.agents.map(({ id }) => id) ?? agents;
  const displayItems = useMemo(() => items.map(item => ({ ...item, status: tones[item.status],
    ...(item.preparation ? { progress: preparationLabels[item.preparation.stage], error: item.preparation.error } : {}),
  })), [items]);
  const controls = useBoardControls(displayItems, labels);
  const [creating, setCreating] = useState(false), [notice, setNotice] = useState("");
  const [selected, setSelected] = useState<{ id: string; title: string; agent?: string; button: HTMLButtonElement } | null>(null);
  const openTask = useCallback<OpenTask>((item, button) => setSelected({ ...item, button }), []);
  const addButton = useRef<HTMLButtonElement>(null);
  const feedback = [error ? "Live updates unavailable" : notice, controls.hasFilters ? `${controls.visible.length} matching tasks` : "",
    !configured.length ? "No agents configured. Add an agent configuration before creating a task." : ""].filter(Boolean).join(" ");
  return <TooltipProvider>
    <BoardSnapshot title="Tasks" footer={footer ?? <ArchivedTasks items={archive.archived} />} onOpenTask={openTask} columns={spoolStatuses.map(({ id, label, tone }) => ({
      id, label, tone, items: controls.visible.filter((item) => item.status === tone),
      total: displayItems.filter((item) => item.status === tone).length,
      actions: id === "completed" || id === "failed" ? <ColumnArchiveMenu label={label}
        count={items.filter((item) => item.status === id).length} pending={archive.pending}
        onArchive={async () => {
          const count = await archive.archive(id);
          setNotice(`Archived ${count} ${count === 1 ? "task" : "tasks"}.`);
        }} /> : undefined,
    }))} header={<BoardToolbar title="Tasks" controls={controls} statusLabels={labels} defaultOrderLabel="Default order"
      adding={creating || !configured.length} addButtonRef={addButton} onAdd={() => { setNotice(""); setCreating(true); }} />}
      feedback={<Text asChild variant="meta"><p role="status" className={feedback ? styles.feedback : styles.srOnly}>{feedback}</p></Text>} />
    {creating && <NewTaskDialog project={project} agents={configured} onOpenChange={setCreating}
      onCreated={(message) => { setNotice(message); setCreating(false); }}
      onCloseAutoFocus={(event) => { event.preventDefault(); addButton.current?.focus(); }} />}
    {selected && <TaskChatDialog key={selected.id} project={project} task={selected} onClose={() => setSelected(null)}
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        const target = selected.button.isConnected ? selected.button
          : document.querySelector<HTMLElement>(`[data-work-item-id="${CSS.escape(selected.id)}"] button`) ?? document.getElementById("board-items");
        target?.focus();
      }} />}
  </TooltipProvider>;
}
