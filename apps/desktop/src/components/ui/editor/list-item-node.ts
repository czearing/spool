import { $create, setDOMUnmanaged, type EditorConfig, type LexicalEditor } from "lexical";
import { $isListNode, ListItemNode } from "@lexical/list";
import styles from "./editor-content.module.css";

export class EditorListItemNode extends ListItemNode {
  $config() { return this.config("editor-listitem", { extends: ListItemNode }); }
  createDOM(config: EditorConfig) {
    const dom = super.createDOM(config);
    const host = document.createElement("span");
    host.contentEditable = "false"; host.dataset.checkboxHost = ""; host.className = styles.checkboxHost;
    setDOMUnmanaged(host, { captureSelection: true });
    const content = document.createElement("div");
    content.dataset.listContent = ""; content.id = `task-content-${this.getKey()}`; content.className = styles.listContent;
    dom.append(host, content);
    this.updateCheckboxDOM(dom);
    return dom;
  }
  getDOMSlot(dom: HTMLElement) {
    return super.getDOMSlot(dom).withElement(dom.querySelector<HTMLElement>(":scope > [data-list-content]")!);
  }
  updateListItemDOM(previous: ListItemNode | null, dom: HTMLLIElement, config: EditorConfig) {
    super.updateListItemDOM(previous, dom, config); this.updateCheckboxDOM(dom);
  }
  updateCheckboxDOM(dom: HTMLElement) {
    dom.removeAttribute("role"); dom.removeAttribute("aria-checked"); dom.removeAttribute("tabindex");
    const host = dom.querySelector<HTMLElement>(":scope > [data-checkbox-host]");
    if (host) host.hidden = this.getChecked() === undefined || $isListNode(this.getFirstChild());
  }
  exportDOM(editor: LexicalEditor) {
    const output = super.exportDOM(editor);
    if (output.element instanceof HTMLElement) {
      output.element.querySelector("[data-checkbox-host]")?.remove();
      output.element.querySelector("[data-list-content]")?.remove();
      if (this.getChecked() !== undefined) output.element.setAttribute("aria-checked", String(this.getChecked()));
    }
    return output;
  }
}
export const listItemReplacement = {
  replace: ListItemNode, with: (node: ListItemNode) => {
    const replacement = $create(EditorListItemNode);
    // Detached items have no list parent, so getChecked() cannot report their stored state.
    ListItemNode.prototype.afterCloneFrom.call(replacement, node);
    return replacement;
  },
  withKlass: EditorListItemNode,
};
