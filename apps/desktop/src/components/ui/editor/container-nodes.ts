import { ElementNode, $applyNodeReplacement, $getNodeByKey, $createParagraphNode, type EditorConfig, type LexicalEditor,
  type NodeKey, type SerializedElementNode, type LexicalNode, type RangeSelection } from "lexical";
import styles from "./editor-content.module.css";
import { createCalloutDOM } from "../callout";
import { createCollapsibleDOM, createCollapsibleTitleDOM, createCollapsibleContentDOM } from "../collapsible";

export class CalloutNode extends ElementNode {
  static getType() { return "callout"; }
  static clone(node: CalloutNode) { return new CalloutNode(node.__key); }
  createDOM() { const dom = createCalloutDOM(document); dom.classList.add(styles.container); return dom; }
  updateDOM() { return false; }
  static importJSON(node: SerializedElementNode) { return $createCalloutNode().updateFromJSON(node); }
  isShadowRoot() { return true; }
}
export class ToggleNode extends ElementNode {
  __open: boolean;
  static getType() { return "toggle"; }
  static clone(node: ToggleNode) { return new ToggleNode(node.__open, node.__key); }
  constructor(open = true, key?: NodeKey) { super(key); this.__open = open; }
  getOpen() { return this.getLatest().__open; }
  setOpen(open: boolean) { this.getWritable().__open = open; }
  createDOM(_config: EditorConfig, editor: LexicalEditor) {
    const key = this.getKey();
    const dom = createCollapsibleDOM(document, this.getOpen(), (open) => {
      editor.update(() => { const node = $getNodeByKey(key); if (node instanceof ToggleNode && node.getOpen() !== open) node.setOpen(open); });
    });
    dom.classList.add(styles.container);
    return dom;
  }
  updateDOM(previous: ToggleNode, dom: HTMLDetailsElement) { if (previous.__open !== this.__open) dom.open = this.__open; return false; }
  exportJSON() { return { ...super.exportJSON(), open: this.getOpen() }; }
  static importJSON(node: SerializedElementNode & { open?: boolean }) { return $createToggleNode(node.open).updateFromJSON(node); }
  canBeEmpty() { return false; }
}
export class ToggleTitleNode extends ElementNode {
  static getType() { return "toggle-title"; }
  static clone(node: ToggleTitleNode) { return new ToggleTitleNode(node.__key); }
  createDOM() { return createCollapsibleTitleDOM(document); }
  updateDOM() { return false; }
  static importJSON(node: SerializedElementNode) { return $applyNodeReplacement(new ToggleTitleNode()).updateFromJSON(node); }
  insertNewAfter(_selection: RangeSelection) {
    const paragraph = $createParagraphNode();
    this.getNextSibling<ToggleContentNode>()?.append(paragraph); paragraph.select();
    return paragraph;
  }
  collapseAtStart() { return false; }
}
export class ToggleContentNode extends ElementNode {
  static getType() { return "toggle-content"; }
  static clone(node: ToggleContentNode) { return new ToggleContentNode(node.__key); }
  createDOM() { return createCollapsibleContentDOM(document); }
  updateDOM() { return false; }
  static importJSON(node: SerializedElementNode) { return $applyNodeReplacement(new ToggleContentNode()).updateFromJSON(node); }
  isShadowRoot() { return true; }
}
export function $createCalloutNode() { return $applyNodeReplacement(new CalloutNode()); }
export function $createToggleNode(open = true) { return $applyNodeReplacement(new ToggleNode(open)); }
export function $createToggleTitle() { return $applyNodeReplacement(new ToggleTitleNode()); }
export function $createToggleContent() { return $applyNodeReplacement(new ToggleContentNode()); }
export function $isContainer(node: LexicalNode | null): node is CalloutNode | ToggleContentNode {
  return node instanceof CalloutNode || node instanceof ToggleContentNode;
}
