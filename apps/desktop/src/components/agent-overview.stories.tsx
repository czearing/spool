import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { AgentOverview } from "./agent-overview";
import { AgentActionsMenu } from "./agent-actions-menu";
import { TaskChatView } from "./task-chat-view";
import { conversationTitle } from "../lib/agent-conversations";
import type { AgentJob, AgentJobs } from "../lib/agent-jobs";
import type { TaskConversation } from "../lib/task-conversation";

const job: AgentJob = { key: "current:1", id: "TASK-42", title: "Improve the initial page load",
  status: "in_progress", archived: false, updatedAt: "2026-09-29T20:45:00Z" };
const meta = {
  title: "Agents/Overview", component: AgentOverview, parameters: { layout: "fullscreen" },
  args: { project: "bohemia", selected: null, onSelect: () => {}, children: null,
    agent: "software-engineer", actions: <AgentActionsMenu agent="software-engineer" editLink={<a href="#prompt">Edit prompt</a>} onDelete={() => {}} />,
    jobs: { current: [job], history: [
      { ...job, key: "completed:2", id: "TASK-41", title: "Simplify the navigation", status: "completed", updatedAt: "2026-09-29T19:12:00Z" },
      { ...job, key: "archive:1", status: "failed", archived: true, updatedAt: "2026-09-28T16:30:00Z" },
    ] } },
  render: function Preview(args) {
    const [selected, select] = useState<string | null>(args.selected), [jobs, setJobs] = useState<AgentJobs>(args.jobs);
    const [entries, setEntries] = useState<TaskConversation["entries"]>([
      { kind: "user", ts: "2026-10-05T19:00:00Z", text: "Help me plan the next chapter." },
      { kind: "assistant", ts: "2026-10-05T19:00:01Z", text: "Let's start with the chapter's main idea, then work through the outline together." },
    ]);
    return <div style={{ height: "100dvh" }}><AgentOverview {...args} jobs={jobs} selected={selected} onSelect={select}>
      <TaskChatView key={selected ?? "new"} presentation="page" onRetry={() => {}}
        welcome={!selected ? <h2>What would you like to work on?</h2> : undefined}
        data={selected ? { task: { id: selected, title: "Conversation", agent: args.agent, status: "in_progress", prompt: "" },
          entries, available: true, limited: false, nextBefore: null, cursor: 0, canSend: true, readOnlyReason: "", activity: "waiting" } : undefined}
        composer={{ label: "Message agent", placeholder: `Message ${args.agent}...`, onSubmit: async ({ id, markdown }) => {
          if (selected) setEntries((previous) => [...previous, { kind: "user", ts: new Date().toISOString(), text: markdown }]);
          else {
            setJobs((previous) => ({ ...previous, current: [{ ...job, id, key: id, title: conversationTitle(markdown) }, ...previous.current] }));
            setEntries([{ kind: "user", ts: new Date().toISOString(), text: markdown }]); select(id);
          }
        } }} />
    </AgentOverview></div>;
  },
} satisfies Meta<typeof AgentOverview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Empty: Story = { args: { jobs: { current: [], history: [] } } };
export const Conversation: Story = { args: { selected: job.id } };
export const MultipleActive: Story = { args: { jobs: { ...meta.args.jobs, current: [
  job, { ...job, key: "current:3", id: "TASK-43", title: "Fix keyboard navigation" },
] } } };
export const LongHistory: Story = { args: { jobs: { current: [], history: Array.from({ length: 100 }, (_, index) => ({
  ...job, key: `completed:${index}`, id: `TASK-${index}`, title: `Conversation ${index + 1}`, status: "completed",
})) } } };
