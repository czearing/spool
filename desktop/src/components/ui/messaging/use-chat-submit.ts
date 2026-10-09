import { useCallback, useEffect, useRef, useState } from "react";
import { $getRoot, $createParagraphNode, CLEAR_HISTORY_COMMAND, type LexicalEditor } from "lexical";
import type { ChatInputProps, ChatSubmission } from "../chat-input";
import { $exportChatMarkdown } from "./chat-markdown";

export function useChatSubmit(editor: LexicalEditor, props: ChatInputProps) {
  const callbacks = useRef(props); callbacks.current = props;
  const revision = useRef(0), request = useRef<AbortController | null>(null);
  const retry = useRef<{ value: ChatSubmission; revision: number } | null>(null);
  const [pending, setPending] = useState(false), [empty, setEmpty] = useState(true), [error, setError] = useState("");
  const [canRetry, setCanRetry] = useState(false);
  useEffect(() => {
    const checkEmpty = () => editor.getEditorState().read(() => setEmpty(!$getRoot().getTextContent().trim()));
    checkEmpty();
    return editor.registerUpdateListener(({ editorState, dirtyElements, dirtyLeaves }) => {
      if (!dirtyElements.size && !dirtyLeaves.size) return;
      revision.current++;
      setCanRetry(false);
      checkEmpty();
      callbacks.current.onDraftChange?.(editorState);
    });
  }, [editor]);
  useEffect(() => () => { request.current?.abort(); request.current = null; }, []);
  const submit = useCallback(async () => {
    if (request.current || callbacks.current.disabled || callbacks.current.onStop || editor.isComposing()) return;
    const markdown = editor.read(() => $getRoot().getTextContent().trim() ? $exportChatMarkdown() : "");
    if (!markdown) return;
    const version = revision.current;
    const value = retry.current?.revision === version ? retry.current.value : { id: crypto.randomUUID(), markdown };
    const controller = new AbortController();
    request.current = controller; setPending(true); setError(""); setCanRetry(false);
    try {
      await callbacks.current.onSubmit(value, controller.signal);
      if (request.current !== controller) return;
      retry.current = null;
      if (version === revision.current) {
        // Acceptance must never erase edits made while the request was in flight.
        editor.update(() => { $getRoot().clear().append($createParagraphNode()); }, { discrete: true });
        editor.dispatchCommand(CLEAR_HISTORY_COMMAND, undefined);
      }
    } catch (cause) {
      if (request.current !== controller) return;
      retry.current = { value, revision: version };
      setCanRetry(version === revision.current);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (request.current === controller) { request.current = null; setPending(false); }
    }
  }, [editor]);
  return { submit, pending, empty, error, canRetry };
}
