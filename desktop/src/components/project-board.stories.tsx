import type { Meta, StoryObj } from "@storybook/react-vite";
import { ProjectBoard } from "./project-board";
import { WorkItemsProvider } from "../hooks/use-work-items";

const meta = {
  title: "Tasks/Board", component: ProjectBoard, parameters: { layout: "fullscreen" },
  decorators: [(Story) => <WorkItemsProvider><Story /></WorkItemsProvider>],
  args: { project: "demo", agents: [], items: [
    { id: "TASK-1", title: "Improve initial page loading", status: "incoming", agent: "software-engineer" },
    { id: "TASK-2", title: "Review keyboard navigation", status: "in_progress", agent: "reviewer" },
    { id: "TASK-3", title: "Simplify the shared controls", status: "completed", agent: "software-engineer" },
    { id: "TASK-4", title: "Investigate a failing build", status: "failed", agent: "software-engineer" },
  ] },
} satisfies Meta<typeof ProjectBoard>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Preparing: Story = { args: { preparations: [
  { id: "manual-1", title: "Review page loading", agent: "software-engineer", stage: "preparing" },
  { id: "manual-2", title: "Update instructions", agent: "prompt-engineer", stage: "waiting" },
] } };
export const PreparationFailed: Story = { args: { preparations: [
  { id: "manual-3", title: "Review changes", agent: "reviewer", stage: "failed", error: "Workspace has uncommitted changes." },
] } };
