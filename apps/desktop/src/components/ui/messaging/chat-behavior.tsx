import { useEffect } from "react";
import { $getSelection, $isRangeSelection, FORMAT_TEXT_COMMAND,
  KEY_ENTER_COMMAND, PASTE_COMMAND, COMMAND_PRIORITY_HIGH, type LexicalEditor } from "lexical";
import { $isCodeNode } from "@lexical/code-core";
import { LinkNode } from "@lexical/link";
import { $findMatchingParent, $unwrapNode, mergeRegister } from "@lexical/utils";
import { $generateNodesFromMarkdownString } from "@lexical/markdown";
import { chatTransformers } from "./chat-markdown";
import { safeEditorUrl } from "../editor/urls";

export function ChatBehavior({ editor, submit, reportError }: {
  editor: LexicalEditor; submit: () => Promise<void>; reportError: (error: Error) => void;
}) {
  useEffect(() => mergeRegister(
    editor.registerCommand(KEY_ENTER_COMMAND, (event) => {
      if (!event || event.isComposing || editor.isComposing() || event.keyCode === 229 || event.shiftKey || event.altKey) return false;
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return false;
      event.preventDefault(); if (!event.repeat) void submit();
      return true;
    }, COMMAND_PRIORITY_HIGH),
    editor.registerCommand(FORMAT_TEXT_COMMAND, (format) => !["bold", "italic", "strikethrough", "code"].includes(format), COMMAND_PRIORITY_HIGH),
    editor.registerNodeTransform(LinkNode, (node) => {
      if (!safeEditorUrl(node.getURL())) {
        $unwrapNode(node);
        reportError(new Error("An unsupported link was kept as plain text."));
      }
    }),
    editor.registerCommand(PASTE_COMMAND, (event) => {
      if (!(event instanceof ClipboardEvent)) return false;
      const text = event.clipboardData?.getData("text/plain");
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return false;
      event.preventDefault();
      if (!text) {
        reportError(new Error("Only text can be pasted into a message. Paste text or Markdown instead."));
        return true;
      }
      if ($findMatchingParent(selection.anchor.getNode(), $isCodeNode)) selection.insertRawText(text.replace(/\r\n?/g, "\n"));
      else {
        selection.insertNodes($generateNodesFromMarkdownString(text.replace(/\r\n?/g, "\n"), chatTransformers, true));
      }
      return true;
    }, COMMAND_PRIORITY_HIGH),
  ), [editor, submit, reportError]);
  return null;
}
