import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RunnerWorkflowEditor } from "./runner-workflow-editor";
import { newRunnerWorkflow, type RunnerWorkflow } from "../lib/runner-workflow";
import { managedFixture } from "./runner-managed-fixtures";

const workflow: RunnerWorkflow = {
  id: "daily-notes", name: "Daily notes", kind: "custom", enabled: false,
  workspace: "C:\\Work\\notes", intervalSeconds: 3600, revision: "story-initial",
  nodes: [
    { id: "schedule", kind: "schedule", label: "Schedule", position: { x: 0, y: 0 } },
    { id: "update", kind: "command", label: "Update workspace", command: '& "C:\\Scripts\\update-notes.ps1"', position: { x: 300, y: 0 } },
    { id: "scan", kind: "command", label: "Check for work", command: '& "C:\\Scripts\\check-notes.ps1"', position: { x: 600, y: 0 } },
  ],
  edges: [{ id: "schedule-update", source: "schedule", target: "update" }, { id: "update-scan", source: "update", target: "scan" }],
};
const meta = { title: "Runners/Workflow editor", component: RunnerWorkflowEditor, parameters: { layout: "fullscreen" },
  decorators: [Story => <QueryClientProvider client={new QueryClient()}><Story /></QueryClientProvider>],
  args: { initial: workflow, onBack: () => {}, onBrowse: async () => "C:\\Work\\notes",
    onBrowseFile: async () => "C:\\Work\\notes\\chapter.md",
    agents: ["editor", "engineer"],
    onSave: async value => ({ ...value, revision: "story-saved" }) },
} satisfies Meta<typeof RunnerWorkflowEditor>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const NewRunner: Story = { args: { initial: newRunnerWorkflow() } };
export const RepositoryWorkflow: Story = { args: { initial: { ...workflow, name: "Repository maintenance",
  nodes: [workflow.nodes[0],
    { id: "update", kind: "repository", operation: "refresh", label: "Refresh repository", position: { x: 224, y: 0 } },
    { id: "scan", kind: "repository", operation: "check", label: "Check changes", position: { x: 448, y: 0 } }],
} } };
export const FileEvent: Story = { args: { initial: { ...workflow, name: "Chapter review",
  nodes: [{ ...workflow.nodes[0], kind: "file-change", path: "chapter.md", label: "When a file changes" },
    { id: "review", kind: "agent", agent: "editor", prompt: "Review the changed chapter.", label: "Assign agent task", position: { x: 280, y: 0 } }],
  edges: [{ id: "file-review", source: "schedule", target: "review" }],
} } };
export const ManagedRunner: Story = { args: { initial: managedFixture("livesite") } };
export const SaveFailure: Story = { args: {
  onSave: async () => { throw new Error("Runner changed elsewhere. Reload before saving."); },
} };
