import { useEffect, useState, type RefObject } from "react";
import { $getRoot, $getSelection, $isRangeSelection, type LexicalEditor } from "lexical";
import { mergeRegister } from "@lexical/utils";

export type EditorBlock = { key: string; element: HTMLElement };
export function blockLabel(block: EditorBlock | undefined) {
  return block?.element.textContent?.trim().slice(0, 80) || block?.element.querySelector("img")?.alt || "Empty block";
}
export function useEditorBlocks(editor: LexicalEditor, anchor: HTMLElement, active: RefObject<string | null>) {
  const [blocks, setBlocks] = useState<EditorBlock[]>([]), [hovered, setHovered] = useState<string | null>(null);
  useEffect(() => {
    let elements = new WeakMap<Element, string>();
    const refresh = () => editor.getEditorState().read(() => {
      const root = editor.getRootElement();
      const next = $getRoot().getChildrenKeys().flatMap((key) => {
        let element = editor.getElementByKey(key);
        if (!root || !element || !root.contains(element)) return [];
        while (element.parentElement && element.parentElement !== root) element = element.parentElement;
        return [{ key, element }];
      });
      elements = new WeakMap(next.map(({ key, element }) => [element, key]));
      setBlocks((previous) => previous.length === next.length && previous.every((block, index) =>
        block.key === next[index].key && block.element === next[index].element) ? previous : next);
    });
    const hover = (event: PointerEvent) => {
      if (active.current) return;
      let element = event.target instanceof Element ? event.target : null;
      while (element && !elements.has(element) && element !== anchor) element = element.parentElement;
      if (element && elements.has(element)) setHovered(elements.get(element)!);
    };
    const leave = (event: PointerEvent) => {
      if (!active.current && !(event.relatedTarget instanceof Element && event.relatedTarget.closest("[data-drag-handle]"))
        && !anchor.contains(document.activeElement)) setHovered(null);
    };
    anchor.addEventListener("pointermove", hover); anchor.addEventListener("pointerdown", hover); anchor.addEventListener("pointerleave", leave);
    const unregister = mergeRegister(editor.registerRootListener(refresh),
      editor.registerUpdateListener(({ dirtyElements, editorState }) => {
        if (dirtyElements.get("root")) refresh();
        if (active.current || editor.getRootElement() !== document.activeElement) return;
        editorState.read(() => {
          const selection = $getSelection();
          if ($isRangeSelection(selection)) setHovered(selection.anchor.getNode().getTopLevelElement()?.getKey() || null);
        });
      }));
    return () => {
      unregister(); anchor.removeEventListener("pointermove", hover); anchor.removeEventListener("pointerdown", hover); anchor.removeEventListener("pointerleave", leave);
    };
  }, [active, anchor, editor]);
  return { blocks, hovered, setHovered };
}
