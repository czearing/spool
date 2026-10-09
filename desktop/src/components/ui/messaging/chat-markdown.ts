import { $convertFromMarkdownString, $convertToMarkdownString, CODE, QUOTE, ORDERED_LIST, UNORDERED_LIST,
  TEXT_FORMAT_TRANSFORMERS, LINK, type Transformer } from "@lexical/markdown";
import { QuoteNode } from "@lexical/rich-text";
import { ListNode, ListItemNode } from "@lexical/list";
import { LinkNode, AutoLinkNode } from "@lexical/link";
import { CodeNode } from "@lexical/code-core";

export const chatNodes = [QuoteNode, ListNode, ListItemNode, LinkNode, AutoLinkNode, CodeNode];
export const chatTransformers: Transformer[] = [CODE, QUOTE, UNORDERED_LIST, ORDERED_LIST, ...TEXT_FORMAT_TRANSFORMERS, LINK];
export function $importChatMarkdown(value: string) {
  $convertFromMarkdownString(value.replace(/\r\n?/g, "\n"), chatTransformers, undefined, true);
}
export function $exportChatMarkdown() { return $convertToMarkdownString(chatTransformers, undefined, true); }
