import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatSubmission } from "../chat-input";
import { demoAnswer, type DemoMessage } from "./demo-data";

export function useDemoMessages(initial: DemoMessage[], failFirst = false, response = demoAnswer) {
  const [messages, setMessages] = useState(initial), [active, setActive] = useState<DemoMessage | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const failedOnce = useRef(false), accepted = useRef(new Set<string>());
  const stream = useRef<{ timer: ReturnType<typeof setInterval>; message: DemoMessage } | null>(null);
  const lastResponse = useRef<DemoMessage | null>(null);
  useEffect(() => () => { if (stream.current) clearInterval(stream.current.timer); }, []);
  const stop = useCallback(() => {
    const active = stream.current;
    if (!active) return;
    clearInterval(active.timer); stream.current = null;
    lastResponse.current = { ...active.message, status: "stopped" };
    setActive(lastResponse.current); setAnnouncement("Response stopped. Partial content is preserved.");
  }, []);
  const send = useCallback(async (submission: ChatSubmission, signal: AbortSignal) => {
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(new Error("Submission cancelled.")); };
      const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 500);
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
    if (signal.aborted) throw new Error("Submission cancelled.");
    if (failFirst && !failedOnce.current) { failedOnce.current = true; throw new Error("The demo connection was interrupted. Try again."); }
    if (accepted.current.has(submission.id)) return;
    accepted.current.add(submission.id);
    stop();
    const id = `answer-${submission.id}`;
    const previousResponse = lastResponse.current;
    setMessages((previous) => [...previous,
      ...(previousResponse ? [previousResponse] : []),
      { id: submission.id, author: "You", direction: "outgoing", markdown: submission.markdown, status: "accepted" }]);
    const message: DemoMessage = { id, author: "Assistant", markdown: "", status: "generating" };
    lastResponse.current = message;
    setActive(message); setAnnouncement("Message accepted. Assistant is responding.");
    let offset = 0;
    const timer = setInterval(() => {
      offset = Math.min(offset + 8, response.length);
      const done = offset === response.length;
      const next: DemoMessage = { ...message, markdown: response.slice(0, offset), status: done ? "complete" : "generating" };
      if (!stream.current || stream.current.message.id !== id) return;
      stream.current.message = next; lastResponse.current = next;
      setActive(next);
      if (done) {
        clearInterval(timer); stream.current = null; setAnnouncement("Response complete.");
      }
    }, 60);
    stream.current = { timer, message };
  }, [failFirst, stop, response]);
  return { messages, active, generating: active?.status === "generating", send, stop, announcement };
}
