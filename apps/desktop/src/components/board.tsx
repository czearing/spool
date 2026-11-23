"use client";

import { useEffect, useRef, useState } from "react";
import { DndContext, DragOverlay } from "@dnd-kit/core";
import { useWorkItems } from "../hooks/use-work-items";
import { useBoardDrag } from "../hooks/use-board-drag";
import { useBoardControls } from "../hooks/use-board-controls";
import { selectBoardItems } from "../lib/board-items";
import { statuses, type Status } from "../lib/work-items";
import { ArchiveTarget } from "./archive";
import { BoardLane } from "./board-lane";
import { BoardToolbar } from "./board-toolbar";
import { Card } from "./ui/card";
import { BoardLayout } from "./board-view";
import { Text } from "./ui/text";
import { TooltipProvider } from "./ui/tooltip";
import styles from "./board.module.css";
import controlsStyles from "./board-controls.module.css";

export function Board() {
  const { items, dispatch, execute, error } = useWorkItems();
  const controls = useBoardControls(items);
  const [adding, setAdding] = useState<Status | null>(null);
  const [notice, setNotice] = useState("");
  const focusTarget = useRef<string | null>(null);
  const { active, context } = useBoardDrag(items, dispatch, controls.visible, controls.sort !== "manual", setNotice);
  useEffect(() => { setNotice(""); }, [controls.query, controls.selected, controls.sort]);
  useEffect(() => {
    if (focusTarget.current) {
      (document.getElementById(focusTarget.current) ?? document.getElementById("board-items"))?.focus();
      focusTarget.current = null;
    }
  }, [items, adding]);
  const create = async (title: string, status: Status) => {
    const item = { id: crypto.randomUUID(), title, status, updatedAt: new Date().toISOString() };
    await execute({ type: "create", item });
    const shown = selectBoardItems([item], controls.query, controls.selected, controls.sort).length > 0;
    focusTarget.current = shown ? `work-item-${item.id}` : `add-${status}`;
    setAdding(null);
    setNotice(shown ? `Added ${title.trim()}.` : "Task added. Clear search and filters to see it.");
  };
  const cancel = (status: Status) => { focusTarget.current = `add-${status}`; setAdding(null); };
  const feedback = notice || (controls.hasFilters ? `${controls.visible.length} matching tasks` : "");
  return <TooltipProvider><DndContext {...context}>
    <BoardLayout header={<BoardToolbar controls={controls} adding={adding !== null} onAdd={() => setAdding("backlog")} />}
      feedback={<Text asChild variant="meta"><p role="status" className={feedback ? controlsStyles.feedback : controlsStyles.srOnly}>{feedback}</p></Text>}
      footer={<><ArchiveTarget items={items.filter((item) => item.archived)} />
        {error && <Text asChild><p role="alert">{error.message}</p></Text>}</>}>
      {statuses.map((status) => <BoardLane key={status} status={status} sorted={controls.sort !== "manual"}
        items={controls.visible.filter((item) => item.status === status)}
        total={items.filter((item) => !item.archived && item.status === status).length}
        adding={adding === status} disableAdd={adding !== null}
        onArchive={async () => {
          if (status === "completed" || status === "blocked") await execute({ type: "archive-all", status });
        }}
        onAdd={() => setAdding(status)} onCancel={() => cancel(status)} onCreate={(title) => create(title, status)} />)}
    </BoardLayout>
    <DragOverlay dropAnimation={null}>{active && <Card className={styles.preview} data-overlay><Text variant="action">{active.title}</Text></Card>}</DragOverlay>
  </DndContext></TooltipProvider>;
}
