import { useCallback, useEffect, useRef, useState } from "react";
import type { EditorState } from "lexical";
import type { ChatSubmission } from "../components/ui/chat-input";
import { $exportChatMarkdown } from "../components/ui/messaging/chat-markdown";

type Draft = { markdown: string; pending?: ChatSubmission };
const drafts = new Map<string, Draft>();
export function useTaskChatDraft(project: string, task: string) {
  const key = `spool-chat:${project}:${task}`;
  const [initial] = useState(() => {
    try {
      const value: Draft = drafts.get(key) ?? JSON.parse(sessionStorage.getItem(key) ?? '{"markdown":""}');
      if (typeof value.markdown !== "string" || (value.pending &&
        (typeof value.pending.id !== "string" || typeof value.pending.markdown !== "string"))) throw new Error("Invalid saved draft.");
      return { value, error: "" };
    } catch (error) {
      console.error("Could not restore chat draft.", error);
      return { value: { markdown: "" } as Draft, error: "Could not restore the saved draft." };
    }
  });
  const [error, setError] = useState(initial.error), saved = useRef(initial.value);
  const state = useRef<EditorState | null>(null), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const save = useCallback((value: Draft) => {
    sessionStorage.setItem(key, JSON.stringify(value));
    drafts.set(key, value); saved.current = value;
  }, [key]);
  const flush = useCallback(() => {
    clearTimeout(timer.current);
    const markdown = state.current?.read($exportChatMarkdown) ?? saved.current.markdown;
    save({ markdown, pending: saved.current.pending?.markdown === markdown ? saved.current.pending : undefined });
  }, [save]);
  const persist = useCallback(() => {
    try { flush(); }
    catch (cause) { console.error("Could not save chat draft.", cause); setError("Draft could not be saved in this browser."); }
  }, [flush]);
  const onDraftChange = useCallback((value: EditorState) => {
    state.current = value; clearTimeout(timer.current); timer.current = setTimeout(persist, 250);
  }, [persist]);
  useEffect(() => {
    window.addEventListener("pagehide", persist);
    return () => { window.removeEventListener("pagehide", persist); persist(); };
  }, [persist]);
  const prepare = useCallback((submission: ChatSubmission) => {
    flush();
    const pending = saved.current.pending?.markdown === submission.markdown ? saved.current.pending : submission;
    save({ ...saved.current, pending });
    return pending;
  }, [flush, save]);
  const accepted = useCallback((submission: ChatSubmission) => {
    flush();
    if (saved.current.markdown === submission.markdown) state.current = null;
    save({ markdown: saved.current.markdown === submission.markdown ? "" : saved.current.markdown });
  }, [flush, save]);
  return { initialMarkdown: initial.value.markdown, onDraftChange, prepare, accepted, error };
}
