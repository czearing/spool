import type { EditorThemeClasses } from "lexical";
import { HeadingNode, QuoteNode } from "@lexical/rich-text";
import { ListNode, ListItemNode } from "@lexical/list";
import { LinkNode, AutoLinkNode } from "@lexical/link";
import { CodeNode, CodeHighlightNode } from "@lexical/code-core";
import { TableNode, TableCellNode, TableRowNode } from "@lexical/table";
import { HorizontalRuleNode } from "@lexical/extension";
import { ImageNode } from "./image-node";
import { CalloutNode, ToggleNode, ToggleTitleNode, ToggleContentNode } from "./container-nodes";
import { EditorListItemNode, listItemReplacement } from "./list-item-node";
import { EditorDividerNode, dividerReplacement } from "./divider-node";
import styles from "./editor-content.module.css";

export const editorNodes = [HeadingNode, QuoteNode, ListNode, ListItemNode, LinkNode, AutoLinkNode, CodeNode, CodeHighlightNode,
  TableNode, TableRowNode, TableCellNode, HorizontalRuleNode, ImageNode, CalloutNode, ToggleNode, ToggleTitleNode, ToggleContentNode,
  EditorListItemNode, listItemReplacement, EditorDividerNode, dividerReplacement];
export const editorTheme: EditorThemeClasses = {
  paragraph: styles.paragraph,
  heading: { h1: styles.h1, h2: styles.h2, h3: styles.h3, h4: styles.h4, h5: styles.h4, h6: styles.h4 },
  quote: styles.quote, link: styles.link, code: styles.code,
  text: { bold: styles.bold, italic: styles.italic, underline: styles.underline, strikethrough: styles.strike,
    underlineStrikethrough: styles.underlineStrike, code: styles.inlineCode, highlight: styles.highlight },
  list: { ul: styles.ul, ol: styles.ol, checklist: styles.checklist, listitem: styles.listitem,
    listitemChecked: styles.checked, listitemUnchecked: styles.unchecked, nested: { listitem: styles.nested } },
  table: styles.table, tableCell: styles.cell, tableCellHeader: styles.cellHeader,
  tableCellSelected: styles.cellSelected, tableScrollableWrapper: styles.tableScroll, tableSelection: styles.tableSelection,
  codeHighlight: { comment: styles.syntaxMuted, punctuation: styles.syntaxMuted, keyword: styles.syntaxKeyword,
    string: styles.syntaxString, function: styles.syntaxKeyword, number: styles.syntaxNumber, boolean: styles.syntaxNumber },
};
