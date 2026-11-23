import { $create } from "lexical";
import { HorizontalRuleNode } from "@lexical/extension";
import { Divider } from "../divider";
import styles from "./editor-content.module.css";

export class EditorDividerNode extends HorizontalRuleNode {
  $config() { return this.config("editor-divider", { extends: HorizontalRuleNode }); }
  createDOM() { const element = document.createElement("div"); element.className = styles.dividerBlock; return element; }
  decorate() { return <Divider decorative={false} />; }
}
export const dividerReplacement = {
  replace: HorizontalRuleNode, with: () => $create(EditorDividerNode), withKlass: EditorDividerNode,
};
