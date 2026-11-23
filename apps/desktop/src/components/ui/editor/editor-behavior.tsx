import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getSelection, $isRangeSelection, $isElementNode, $createParagraphNode, $createTextNode, TextNode,
  KEY_ENTER_COMMAND, KEY_TAB_COMMAND, PASTE_COMMAND, INDENT_CONTENT_COMMAND, OUTDENT_CONTENT_COMMAND, COMMAND_PRIORITY_LOW } from "lexical";
import { $isListNode, $isListItemNode } from "@lexical/list";
import { $findMatchingParent, mergeRegister } from "@lexical/utils";
import { CodeNode, $isCodeNode } from "@lexical/code-core";
import { LinkNode } from "@lexical/link";
import { $convertFromMarkdownString, CHECK_LIST } from "@lexical/markdown";
import { $isContainer, ToggleContentNode } from "./container-nodes";
import { markdownTransformers } from "./markdown";
import { safeEditorUrl } from "./urls";

export function EditorBehavior({ onError }: { onError: (error: Error) => void }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    let disposed = false, loading = false, unregisterHighlight = () => {};
    const cleanup = mergeRegister(
      editor.registerNodeTransform(TextNode, (node) => {
        const item = node.getParent(), list = item?.getParent();
        if (!editor.isEditable() || editor.isComposing() || !$isListItemNode(item) || !$isListNode(list)
          || list.getListType() !== "bullet" || item.getFirstChild() !== node || node.hasFormat("code")) return;
        const match = node.getTextContent().match(CHECK_LIST.regExp);
        if (!match) return;
        const children = item.getChildren(), paragraph = $createParagraphNode();
        item.replace(paragraph); paragraph.append(...children);
        node.setTextContent(node.getTextContent().slice(match[0].length));
        CHECK_LIST.replace(paragraph, paragraph.getChildren(), match, false);
      }),
      editor.registerMutationListener(CodeNode, (mutations) => {
        if (loading || ![...mutations.values()].some((type) => type !== "destroyed")) return;
        loading = true;
        import("@lexical/code-prism").then(({ registerCodeHighlighting, PrismTokenizer }) => {
          if (!disposed) unregisterHighlight = registerCodeHighlighting(editor, { ...PrismTokenizer, defaultLanguage: null });
        }).catch((error: Error) => { if (!disposed) onError(error); });
      }, { skipInitialization: false }),
      editor.registerNodeTransform(LinkNode, (node) => {
        if (!safeEditorUrl(node.getURL())) { node.replace($createTextNode(node.getTextContent())); onError(new Error("An unsupported link URL was removed.")); }
      }),
      editor.registerCommand(KEY_TAB_COMMAND, (event) => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !$findMatchingParent(selection.anchor.getNode(), $isListNode)) return false;
        event.preventDefault();
        editor.dispatchCommand(event.shiftKey ? OUTDENT_CONTENT_COMMAND : INDENT_CONTENT_COMMAND, undefined); return true;
      }, COMMAND_PRIORITY_LOW),
      editor.registerCommand(KEY_ENTER_COMMAND, (event) => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed() || event?.shiftKey) return false;
        const node = selection.anchor.getNode();
        if (!$isElementNode(node) || !node.isEmpty() || !$isContainer(node.getParent())) return false;
        const container = node.getParent()!;
        const block = container instanceof ToggleContentNode ? container.getParent()! : container;
        event?.preventDefault(); const paragraph = $createParagraphNode(); block.insertAfter(paragraph);
        node.remove(); paragraph.select(); return true;
      }, COMMAND_PRIORITY_LOW),
      editor.registerCommand(PASTE_COMMAND, (event) => {
        if (!(event instanceof ClipboardEvent)) return false;
        const data = event.clipboardData, text = data?.getData("text/plain") || "";
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || data?.getData("text/html") || $findMatchingParent(selection.anchor.getNode(), $isCodeNode)
          || !/^(?:#{1,6} |[-*+] |[0-9]+\. |```|> |\|.+\||:::)/m.test(text)) return false;
        const container = $createParagraphNode();
        $convertFromMarkdownString(text, markdownTransformers, container);
        event.preventDefault(); selection.insertNodes(container.getChildren()); return true;
      }, COMMAND_PRIORITY_LOW),
    );
    return () => { disposed = true; unregisterHighlight(); cleanup(); };
  }, [editor, onError]);
  return null;
}
