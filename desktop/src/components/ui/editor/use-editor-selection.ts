import { useEffect, useRef, useState } from "react";
import { $getSelection, $getRoot, $isRangeSelection, $setSelection, CAN_UNDO_COMMAND, CAN_REDO_COMMAND,
  COMMAND_PRIORITY_LOW, type BaseSelection, type LexicalNode, type TextFormatType } from "lexical";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $isHeadingNode } from "@lexical/rich-text";
import { $isCodeNode } from "@lexical/code-core";
import { $isListNode } from "@lexical/list";
import { $isLinkNode } from "@lexical/link";
import { $isTableCellNode } from "@lexical/table";
import { mergeRegister } from "@lexical/utils";

const formats: TextFormatType[] = ["bold", "italic", "underline", "strikethrough", "code", "highlight"];
const initial = { block: "paragraph", format: "", link: "", table: false, language: "", range: "" };
export function useEditorSelection() {
  const [editor] = useLexicalComposerContext();
  const saved = useRef<BaseSelection | null>(null);
  const [state, setState] = useState(initial);
  const [canUndo, setCanUndo] = useState(false), [canRedo, setCanRedo] = useState(false);
  useEffect(() => mergeRegister(
    editor.registerUpdateListener(({ editorState }) => editorState.read(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return;
      saved.current = selection.clone();
      let node: LexicalNode | null = selection.anchor.getNode();
      const next = { ...initial, range: selection.isCollapsed() ? "" : `${selection.anchor.key}:${selection.anchor.offset}-${selection.focus.key}:${selection.focus.offset}`,
        format: formats.filter((format) => selection.hasFormat(format)).join(" ") };
      while (node && node.getType() !== "root") {
        if ($isHeadingNode(node)) next.block = node.getTag();
        if ($isListNode(node)) next.block = node.getListType();
        if ($isCodeNode(node)) { next.block = "code"; next.language = node.getLanguage() || "plain"; }
        if (["quote", "callout", "toggle"].includes(node.getType())) next.block = node.getType();
        if ($isLinkNode(node)) next.link = node.getURL();
        if ($isTableCellNode(node)) next.table = true;
        node = node.getParent();
      }
      setState((previous) => Object.keys(next).every((key) => previous[key as keyof typeof next] === next[key as keyof typeof next]) ? previous : next);
    })),
    editor.registerCommand(CAN_UNDO_COMMAND, (value) => { setCanUndo(value); return false; }, COMMAND_PRIORITY_LOW),
    editor.registerCommand(CAN_REDO_COMMAND, (value) => { setCanRedo(value); return false; }, COMMAND_PRIORITY_LOW),
  ), [editor]);
  const run = (action: () => void) => editor.update(() => {
    if (saved.current) $setSelection(saved.current.clone()); else $getRoot().selectEnd();
    action();
  });
  return { editor, state, canUndo, canRedo, run };
}
