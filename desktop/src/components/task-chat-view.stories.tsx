import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import type { TaskConversation } from "../lib/task-conversation";
import { TaskChatView } from "./task-chat-view";
import { Dialog } from "./ui/dialog";
import { Button } from "./ui/button";

const conversation: TaskConversation = {
  task: { id: "demo-task", title: "Improve keyboard navigation", agent: "software-engineer", status: "in_progress",
    prompt: "Make every board card accessible by keyboard." },
  entries: [
    { kind: "user", ts: "2026-09-30T10:00:00Z", text: "Make every board card accessible by keyboard." },
    { kind: "assistant", ts: "2026-09-30T10:00:10Z", text: "The cards now open with **Enter** or **Space**. Closing the conversation returns focus to the card.\n\nI'm checking the narrow-screen layout next." },
  ], available: true, limited: false, nextBefore: null, cursor: 0, canSend: true, readOnlyReason: "", activity: "working",
};
const meta = {
  title: "Tasks/Conversation", component: TaskChatView, parameters: { layout: "centered" },
  args: { data: conversation, onRetry: () => {},
    composer: { label: "Message agent", placeholder: "Message agent...", onSubmit: async () => {} } },
  render: function Preview(args) {
    const [data, setData] = useState(args.data);
    return <Dialog title={data?.task.title ?? "Task conversation"} description="software-engineer"
      presentation="conversation" trigger={<Button>Open task</Button>}>
      <TaskChatView {...args} data={data} composer={{ ...args.composer, onSubmit: async ({ markdown }) => {
        if (data) setData({ ...data, entries: [...data.entries, { kind: "user", ts: new Date().toISOString(), text: markdown }] });
      } }} />
    </Dialog>;
  },
} satisfies Meta<typeof TaskChatView>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Active: Story = {};
export const ToolCalls: Story = { args: { data: { ...conversation, entries: [...conversation.entries,
  { kind: "tool_call", ts: "2026-09-30T10:00:15Z", toolUseId: "read", name: "Read Page Header stories", input: '{ "path": "src\\\\page-header.stories.tsx" }' },
  { kind: "tool_result", ts: "2026-09-30T10:00:16Z", toolUseId: "read", content: "Found the rename and loading-state stories.", isError: false },
  { kind: "tool_call", ts: "2026-09-30T10:00:17Z", toolUseId: "check", name: "Run screenshot tests" },
  { kind: "tool_result", ts: "2026-09-30T10:00:18Z", toolUseId: "check", content: "Screenshot comparison failed.", isError: true },
  { kind: "tool_call", ts: "2026-09-30T10:00:19Z", toolUseId: "prepare", name: "bohemia_prepare", input: '{ "operation": "branch" }' },
] } } };
export const NoReplies: Story = { args: { data: { ...conversation, entries: [] } } };
export const EmptyConversation: Story = { args: { data: { ...conversation, task: { ...conversation.task, prompt: "" }, entries: [] } } };
export const Completed: Story = { args: { data: { ...conversation, task: { ...conversation.task, status: "completed" },
  activity: "completed" } } };
export const UnavailableSession: Story = { args: { data: { ...conversation, task: { ...conversation.task, status: "completed" },
  canSend: false, readOnlyReason: "No saved session is available for this conversation.", activity: "completed" } } };
export const Disconnected: Story = { args: { error: "Conversation unavailable. Retry to reconnect." } };
export const Loading: Story = { args: { data: undefined } };
export const LongConversation: Story = { args: { data: { ...conversation, entries: Array.from({ length: 60 }, (_, index) => ({
  kind: index % 2 ? "assistant" : "user", ts: new Date(Date.parse("2026-09-30T10:00:00Z") + index * 60000).toISOString(),
  text: `Message ${index + 1}\n\n${"A longer conversation stays inside the dialog. ".repeat(8)}`,
})) } } };
export const QueuedFollowUp: Story = { args: { data: { ...conversation, task: { ...conversation.task, interaction: { messages: [
  { id: "queued-demo", text: "Please check keyboard focus after closing, too.", status: "queued", created_at: "2026-09-30T10:01:00Z" },
] } } } } };
export const WaitingForReply: Story = { args: { data: { ...conversation, activity: "waiting" } } };
export const CompletedWithDraft: Story = { args: { ...UnavailableSession.args, composer: { ...meta.args.composer, initialMarkdown: "My unsent follow-up." } } };
