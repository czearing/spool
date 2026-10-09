import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { $getNodeByKey, COMMAND_PRIORITY_LOW, HISTORY_PUSH_TAG } from "lexical";
import { $insertList, INSERT_CHECK_LIST_COMMAND } from "@lexical/list";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { useLexicalEditable } from "@lexical/react/useLexicalEditable";
import { mergeRegister } from "@lexical/utils";
import { Checkbox } from "../checkbox";
import { EditorListItemNode } from "./list-item-node";

type Task = { host: HTMLElement; checked: boolean };
export function ChecklistControls() {
  const [editor] = useLexicalComposerContext(), editable = useLexicalEditable();
  const [tasks, setTasks] = useState<Map<string, Task>>(() => new Map());
  useEffect(() => mergeRegister(
    editor.registerCommand(INSERT_CHECK_LIST_COMMAND, () => { $insertList("check"); return true; }, COMMAND_PRIORITY_LOW),
    editor.registerMutationListener(EditorListItemNode, (mutations) => {
      const updates = editor.getEditorState().read(() => [...mutations].map(([key, type]) => {
        const node = type === "destroyed" ? null : $getNodeByKey(key);
        const host = editor.getElementByKey(key)?.querySelector<HTMLElement>(":scope > [data-checkbox-host]");
        return [key, node instanceof EditorListItemNode && host && !host.hidden
          ? { host, checked: !!node.getChecked() } : null] as const;
      }));
      setTasks((previous) => {
        if (updates.every(([key, task]) => task ? previous.get(key)?.host === task.host && previous.get(key)?.checked === task.checked : !previous.has(key))) return previous;
        const next = new Map(previous);
        for (const [key, task] of updates) { if (task) next.set(key, task); else next.delete(key); }
        return next;
      });
    }, { skipInitialization: false }),
  ), [editor]);
  return <>{[...tasks].map(([key, { host, checked }]) => createPortal(
    <Checkbox checked={checked} disabled={!editable} aria-labelledby={`task-content-${key}`}
      onCheckedChange={(value) => editor.update(() => {
        const node = $getNodeByKey(key);
        if (!(node instanceof EditorListItemNode)) throw new Error("This checklist item no longer exists.");
        node.setChecked(value === true);
      }, { tag: HISTORY_PUSH_TAG })} />, host, key))}</>;
}
