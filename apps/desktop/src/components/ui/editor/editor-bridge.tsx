import { useEffect, useImperativeHandle, useRef, type Ref } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getRoot, CLEAR_HISTORY_COMMAND, type EditorState, type LexicalEditor, type SerializedEditorState } from "lexical";
import { getExtensionDependencyFromEditor } from "@lexical/extension";
import { HistoryExtension } from "@lexical/history";
import { $convertToMarkdownString } from "@lexical/markdown";
import { $importMarkdown, markdownTransformers } from "./markdown";

export type EditorHandle = {
  focus: () => void;
  getMarkdown: (state?: EditorState) => string;
  getState: () => SerializedEditorState;
  setMarkdown: (markdown: string) => void;
};
export type ChangeProps = {
  onChange?: (state: EditorState) => void;
  onMarkdownChange?: (markdown: string) => void;
};
function seedHistory(editor: LexicalEditor) {
  const history = getExtensionDependencyFromEditor(editor, HistoryExtension).output.historyState.peek();
  // Grips and checkboxes can change a document before its text ever receives focus.
  if (!history.current) history.current = { editor, editorState: editor.getEditorState() };
}
export function EditorBridge({ editorRef, readOnly, onChange, onMarkdownChange }: ChangeProps & {
  editorRef?: Ref<EditorHandle>; readOnly: boolean;
}) {
  const [editor] = useLexicalComposerContext();
  const callbacks = useRef({ onChange, onMarkdownChange });
  callbacks.current = { onChange, onMarkdownChange };
  useEffect(() => { seedHistory(editor); }, [editor]);
  useEffect(() => { editor.setEditable(!readOnly); }, [editor, readOnly]);
  useImperativeHandle(editorRef, () => ({
    focus: () => editor.focus(),
    getMarkdown: (state) => state ? state.read(() => $convertToMarkdownString(markdownTransformers))
      : editor.read(() => $convertToMarkdownString(markdownTransformers)),
    getState: () => editor.getEditorState().toJSON(),
    setMarkdown: (markdown) => {
      editor.update(() => { $importMarkdown(markdown); $getRoot().selectEnd(); }, { discrete: true });
      editor.dispatchCommand(CLEAR_HISTORY_COMMAND, undefined);
      seedHistory(editor);
    },
  }), [editor]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unregister = editor.registerUpdateListener(({ editorState, dirtyElements, dirtyLeaves }) => {
      if (!dirtyElements.size && !dirtyLeaves.size) return;
      callbacks.current.onChange?.(editorState);
      clearTimeout(timer);
      if (callbacks.current.onMarkdownChange) timer = setTimeout(() => {
        callbacks.current.onMarkdownChange?.(editorState.read(() => $convertToMarkdownString(markdownTransformers)));
      }, 300);
    });
    return () => { clearTimeout(timer); unregister(); };
  }, [editor]);
  return null;
}
