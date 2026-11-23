"use client";

import { memo, useCallback, useRef, useState, type Ref } from "react";
import { configExtension, defineExtension, type SerializedEditorState } from "lexical";
import { LexicalExtensionComposer } from "@lexical/react/LexicalExtensionComposer";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { MarkdownShortcutPlugin } from "@lexical/react/LexicalMarkdownShortcutPlugin";
import { RichTextExtension } from "@lexical/rich-text";
import { HistoryExtension } from "@lexical/history";
import { ListExtension } from "@lexical/list";
import { LinkExtension, AutoLinkExtension, autoLinkUrlMatcher, autoLinkEmailMatcher } from "@lexical/link";
import { CodeExtension } from "@lexical/code-core";
import { TableExtension } from "@lexical/table";
import { HorizontalRuleExtension } from "@lexical/extension";
import { TooltipProvider } from "./tooltip";
import { Text } from "./text";
import { EditorToolbar } from "./editor/editor-toolbar";
import { EditorBehavior } from "./editor/editor-behavior";
import { BlockDrag } from "./editor/block-drag";
import { ChecklistControls } from "./editor/checklist-controls";
import { Divider } from "./divider";
import { EditorBridge, type EditorHandle, type ChangeProps } from "./editor/editor-bridge";
import { editorNodes, editorTheme } from "./editor/editor-theme";
import { $importMarkdown, markdownTransformers } from "./editor/markdown";
import { safeEditorUrl } from "./editor/urls";
import styles from "./editor/editor.module.css";

export type { EditorHandle } from "./editor/editor-bridge";
export type EditorProps = ChangeProps & {
  ref?: Ref<EditorHandle>; id?: string; label: string; placeholder?: string; readOnly?: boolean; required?: boolean;
  className?: string; onError?: (error: Error) => void;
  presentation?: "default" | "document"; blockDragging?: boolean;
} & ({ initialMarkdown?: string; initialState?: never } | { initialState: SerializedEditorState; initialMarkdown?: never });

export const Editor = memo(function Editor({ ref, id, label, required, placeholder = "Write something, or type / for blocks...",
  readOnly = false, initialMarkdown = "", initialState, className = "", presentation = "default", blockDragging = true, onChange, onMarkdownChange, onError }: EditorProps) {
  const [error, setError] = useState("");
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null);
  const errorCallback = useRef(onError); errorCallback.current = onError;
  const reportError = useCallback((cause: Error) => {
    console.error(cause); setError(cause.message); errorCallback.current?.(cause);
  }, []);
  const [extension] = useState(() => defineExtension({
    name: "spool/editor", namespace: "spool/editor", nodes: editorNodes, theme: editorTheme,
    editable: !readOnly, onError: reportError,
    $initialEditorState: initialState ? JSON.stringify(initialState) : () => $importMarkdown(initialMarkdown),
    dependencies: [RichTextExtension, HistoryExtension, ListExtension, CodeExtension, HorizontalRuleExtension,
      configExtension(LinkExtension, { validateUrl: safeEditorUrl, attributes: { rel: "noopener noreferrer" } }),
      configExtension(AutoLinkExtension, { matchers: [autoLinkUrlMatcher, autoLinkEmailMatcher] }),
      configExtension(TableExtension, { hasCellMerge: false, hasCellBackgroundColor: false, hasHorizontalScroll: true })],
  }));
  return <div className={`${styles.editor} ${className}`} data-presentation={presentation}>
    <TooltipProvider><LexicalExtensionComposer extension={extension} contentEditable={null}>
      {!readOnly && <EditorToolbar contextual={presentation === "document"} />}
      <div ref={setAnchor} className={styles.surface}><ContentEditable id={id} aria-label={label} aria-required={required || undefined} aria-readonly={readOnly} className={styles.editable}
        aria-placeholder={placeholder} placeholder={() => readOnly ? null : <div className={styles.placeholder}>{placeholder}</div>} />
        {!readOnly && blockDragging && anchor && <BlockDrag anchor={anchor} />}
      </div>
      <EditorBridge editorRef={ref} readOnly={readOnly} onChange={onChange} onMarkdownChange={onMarkdownChange} />
      <EditorBehavior onError={reportError} />
      <ChecklistControls />
      {!readOnly && <MarkdownShortcutPlugin transformers={markdownTransformers} />}
      {!readOnly && presentation === "default" && <><Divider /><Text asChild variant="meta" tone="muted"><div className={styles.hint}>Markdown shortcuts supported. Type / to insert a block.</div></Text></>}
    </LexicalExtensionComposer></TooltipProvider>
    {error && <Text className={styles.error} role="alert">{error}</Text>}
  </div>;
});
