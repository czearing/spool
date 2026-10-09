import type { Meta, StoryObj } from "@storybook/react-vite";
import { useRef, useState } from "react";
import { wideComponentPreview } from "../../../.storybook/component-preview";
import { ChatInput, type ChatInputHandle, type ChatSubmission } from "./chat-input";
import { Button } from "./button";
import { Stack } from "./stack";
import { Text } from "./text";
const meta = {
  title: "Components/Chat input", component: ChatInput, decorators: [wideComponentPreview],
  args: { label: "Message", onSubmit: async (_submission: ChatSubmission, _signal: AbortSignal) => {} },
} satisfies Meta<typeof ChatInput>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Disabled: Story = { args: { disabled: true, initialMarkdown: "A preserved draft." } };
export const Markdown: Story = { args: { initialMarkdown: "**Bold**, *italic*, ~~struck~~ and `code`.\n\n> A thought\n\n- First\n- Second" } };
export const Sending: Story = { args: { initialMarkdown: "Check the empty state and keyboard navigation.",
  onSubmit: (_, signal) => new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new Error("Cancelled")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 3000);
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
  }) } };
export const Retry: Story = { render: function Retry() {
  const failed = useRef(false);
  return <ChatInput label="Message" initialMarkdown="Keep this draft if the connection drops." onSubmit={async () => {
    if (!failed.current) { failed.current = true; throw new Error("Connection interrupted."); }
  }} />;
} };
export const Responding: Story = { render: function Responding() {
  const [running, setRunning] = useState(true);
  return <ChatInput label="Message" placeholder="Write your next message..." onSubmit={async () => {}}
    onStop={running ? () => setRunning(false) : undefined} />;
} };
export const Acceptance: Story = { render: function Acceptance() {
  const [submissions, setSubmissions] = useState<ChatSubmission[]>([]);
  const [pending, setPending] = useState(false);
  const settle = useRef<{ resolve: () => void; reject: (error: Error) => void } | null>(null);
  const editor = useRef<ChatInputHandle>(null), [exported, setExported] = useState("");
  return <Stack gap={3}>
    <ChatInput ref={editor} label="Message" onSubmit={(value, signal) => new Promise<void>((resolve, reject) => {
      setSubmissions((previous) => [...previous, value]); setPending(true);
      const abort = () => reject(new Error("Cancelled"));
      signal.addEventListener("abort", abort, { once: true });
      settle.current = {
        resolve: () => { signal.removeEventListener("abort", abort); setPending(false); resolve(); },
        reject: (error) => { signal.removeEventListener("abort", abort); setPending(false); reject(error); },
      };
    })} />
    <Stack direction="row" gap={2}>
      <Button disabled={!pending} onClick={() => settle.current?.resolve()}>Accept</Button>
      <Button disabled={!pending} onClick={() => settle.current?.reject(new Error("Demo failure"))}>Reject</Button>
      <Button onClick={() => setExported(editor.current?.getMarkdown() || "")}>Export draft</Button>
    </Stack>
    <Text asChild><pre aria-label="Submitted messages">{JSON.stringify(submissions)}</pre></Text>
    <Text asChild><pre aria-label="Exported draft">{exported}</pre></Text>
  </Stack>;
} };
