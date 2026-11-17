import { useCallback, useEffect, useRef, useState } from "react";
import type { EditorState } from "lexical";
import type { ChatSubmission } from "../components/ui/chat-input";
import { $exportChatMarkdown } from "../components/ui/messaging/chat-markdown";

type Draft = { markdown: string };
const drafts = new Map<string, Draft>();
export function useTaskChatDraft(project: string, task: string) {
  const key = `spool-chat:${project}:${task}`;
  const [initial] = useState(() => {
    try {
      const value: Draft = drafts.get(key) ?? JSON.parse(sessionStorage.getItem(key) ?? '{"markdown":""}');
      if (typeof value.markdown !== "string") throw new Error("Invalid saved draft.");
      return { value: { markdown: value.markdown }, error: "" };
    } catch (error) {
      console.error("Could not restore chat draft.", error);
      return { value: { markdown: "" } as Draft, error: "Could not restore the saved draft." };
    }
  });
  const [error, setError] = useState(initial.error), saved = useRef(initial.value);
  const state = useRef<EditorState | null>(null), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const save = useCallback((value: Draft) => {
    drafts.set(key, value); saved.current = value;
    sessionStorage.setItem(key, JSON.stringify(value));
  }, [key]);
  const flush = useCallback(() => {
    clearTimeout(timer.current);
    const markdown = state.current?.read($exportChatMarkdown) ?? saved.current.markdown;
    save({ markdown });
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
  const accepted = useCallback((submission: ChatSubmission) => {
    clearTimeout(timer.current);
    const markdown = state.current?.read($exportChatMarkdown) ?? saved.current.markdown;
    if (markdown === submission.markdown) state.current = null;
    try { save({ markdown: markdown === submission.markdown ? "" : markdown }); }
    catch (cause) { console.error("Could not save chat draft.", cause); setError("Draft could not be saved in this browser."); }
  }, [save]);
  return { initialMarkdown: initial.value.markdown, onDraftChange, accepted, error };
}
