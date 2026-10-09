import { $getSelection, $isRangeSelection, $createParagraphNode, $createTextNode, $isElementNode, $copyNode,
  type LexicalEditor, type LexicalNode } from "lexical";
import { $setBlocksType } from "@lexical/selection";
import { $createHeadingNode, $createQuoteNode } from "@lexical/rich-text";
import { $createCodeNode } from "@lexical/code-core";
import { INSERT_UNORDERED_LIST_COMMAND, INSERT_ORDERED_LIST_COMMAND, INSERT_CHECK_LIST_COMMAND, REMOVE_LIST_COMMAND } from "@lexical/list";
import { INSERT_TABLE_COMMAND } from "@lexical/table";
import { INSERT_HORIZONTAL_RULE_COMMAND } from "@lexical/extension";
import { $createCalloutNode, $createToggleNode, $createToggleTitle, $createToggleContent } from "./container-nodes";
import { Type, Heading1, Heading2, Heading3, List, ListOrdered, ListChecks, Quote, Code2, Minus, Table2, Image, Info, ChevronRight } from "lucide-react";

export const blocks = [
  { id: "paragraph", label: "Text", description: "Start with plain writing", icon: Type },
  { id: "h1", label: "Heading 1", description: "A large section heading", icon: Heading1 },
  { id: "h2", label: "Heading 2", description: "A medium section heading", icon: Heading2 },
  { id: "h3", label: "Heading 3", description: "A small section heading", icon: Heading3 },
  { id: "bullet", label: "Bulleted list", description: "A simple unordered list", icon: List },
  { id: "number", label: "Numbered list", description: "Steps in a sequence", icon: ListOrdered },
  { id: "check", label: "To-do list", description: "Track tasks with checkboxes", icon: ListChecks },
  { id: "quote", label: "Quote", description: "Set a passage apart", icon: Quote },
  { id: "code", label: "Code block", description: "Code with syntax highlighting", icon: Code2 },
  { id: "callout", label: "Callout", description: "Highlight important context", icon: Info },
  { id: "toggle", label: "Toggle", description: "Collapsible details", icon: ChevronRight },
  { id: "divider", label: "Divider", description: "A quiet horizontal separator", icon: Minus },
  { id: "table", label: "Table", description: "A simple editable table", icon: Table2 },
  { id: "image", label: "Image", description: "Insert an image by URL", icon: Image },
] as const;
export type BlockType = typeof blocks[number]["id"];

export function $applyBlock(editor: LexicalEditor, type: BlockType) {
  if (type === "bullet") return editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined);
  if (type === "number") return editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined);
  if (type === "check") return editor.dispatchCommand(INSERT_CHECK_LIST_COMMAND, undefined);
  if (type === "divider") return editor.dispatchCommand(INSERT_HORIZONTAL_RULE_COMMAND, undefined);
  if (type === "table") return editor.dispatchCommand(INSERT_TABLE_COMMAND, { rows: "3", columns: "3", includeHeaders: { rows: true, columns: false } });
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return;
  if (type === "callout" || type === "toggle") {
    const block = selection.anchor.getNode().getTopLevelElement();
    if (!block) return;
    const content = type === "callout" ? $createCalloutNode() : $createToggleContent();
    const node = type === "callout" ? content : $createToggleNode().append($createToggleTitle().append($createTextNode("Details")), content);
    block.insertBefore(node); content.append(block); block.selectEnd(); return;
  }
  editor.dispatchCommand(REMOVE_LIST_COMMAND, undefined);
  const create = () => type === "quote" ? $createQuoteNode() : type === "code" ? $createCodeNode("plain")
    : type === "h1" || type === "h2" || type === "h3" ? $createHeadingNode(type) : $createParagraphNode();
  $setBlocksType($getSelection(), create);
}
function $duplicate(node: LexicalNode): LexicalNode {
  const copy = $copyNode(node);
  if ($isElementNode(node) && $isElementNode(copy)) copy.append(...node.getChildren().map($duplicate));
  return copy;
}
export function $changeBlock(action: "up" | "down" | "duplicate" | "delete") {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return;
  const block = selection.anchor.getNode().getTopLevelElement();
  if (!block) return;
  if (action === "up") block.getPreviousSibling()?.insertBefore(block);
  if (action === "down") block.getNextSibling()?.insertAfter(block);
  if (action === "duplicate") { const copy = $duplicate(block); block.insertAfter(copy); if ($isElementNode(copy)) copy.selectEnd(); }
  if (action === "delete") {
    if (!block.getPreviousSibling() && !block.getNextSibling()) block.insertAfter($createParagraphNode());
    block.selectNext(); block.remove();
  }
}
