import type { EditorThemeClasses } from "lexical";
import styles from "./message-content.module.css";

export const chatTheme: EditorThemeClasses = {
  paragraph: styles.paragraph, quote: styles.quote, code: styles.codeBlock, link: styles.link,
  text: { bold: styles.bold, italic: styles.italic, strikethrough: styles.strike, code: styles.inlineCode },
  list: { ul: styles.list, ol: styles.list, listitem: styles.item, nested: { listitem: styles.nested } },
};
