import { DecoratorNode, $applyNodeReplacement, type NodeKey, type SerializedLexicalNode, type LexicalNode, type DOMConversionMap } from "lexical";
import { useState, type ReactElement } from "react";
import { ImageOff } from "lucide-react";
import { Text } from "../text";
import { Stack } from "../stack";
import { safeEditorUrl } from "./urls";
import styles from "./editor-content.module.css";

type SerializedImage = SerializedLexicalNode & { src: string; alt: string };
function EditorImage({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  return failed || !safeEditorUrl(src, true)
    ? <Stack asChild direction="row" align="center" gap={2}><Text className={styles.imageError} role="status"><ImageOff aria-hidden="true" />Image unavailable{alt && `: ${alt}`}</Text></Stack>
    : <img className={styles.image} src={src} alt={alt} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
}
export class ImageNode extends DecoratorNode<ReactElement> {
  __src: string;
  __alt: string;
  static getType() { return "image"; }
  static clone(node: ImageNode) { return new ImageNode(node.__src, node.__alt, node.__key); }
  constructor(src = "", alt = "", key?: NodeKey) { super(key); this.__src = src; this.__alt = alt; }
  getSrc() { return this.getLatest().__src; }
  getAlt() { return this.getLatest().__alt; }
  createDOM() { const element = document.createElement("span"); element.className = styles.imageWrap; return element; }
  updateDOM() { return false; }
  decorate() { return <EditorImage src={this.getSrc()} alt={this.getAlt()} />; }
  exportJSON(): SerializedImage { return { ...super.exportJSON(), src: this.getSrc(), alt: this.getAlt() }; }
  static importJSON(node: SerializedImage) { return $createImageNode(node.src, node.alt); }
  exportDOM() {
    const element = document.createElement("img");
    if (safeEditorUrl(this.getSrc(), true)) element.src = this.getSrc();
    element.alt = this.getAlt(); element.referrerPolicy = "no-referrer";
    return { element };
  }
  static importDOM(): DOMConversionMap {
    return { img: (element) => safeEditorUrl(element.getAttribute("src") || "", true) ? {
      priority: 1, conversion: (image) => ({ node: $createImageNode(image.getAttribute("src")!, image.getAttribute("alt") || "") }),
    } : null };
  }
}
export function $createImageNode(src: string, alt: string) { return $applyNodeReplacement(new ImageNode(src, alt)); }
export function $isImageNode(node: LexicalNode | null | undefined): node is ImageNode { return node instanceof ImageNode; }
