import type { Meta, StoryObj } from "@storybook/react-vite";
import { BoardSnapshot } from "./board-view";
import { labels, statuses } from "../lib/work-items";
import { seedItems } from "../lib/seed";
import { ArchivedTasks } from "./archived-tasks";
import type { ArchivedSpoolItem } from "../lib/spool-archive";

const meta = { title: "Kanban/ReadOnlyBoard", component: BoardSnapshot,
  args: { title: "Work items", columns: statuses.map((status) => ({
    id: status, label: labels[status], tone: status, items: seedItems.filter((item) => item.status === status),
  })) },
  parameters: { docs: { description: { component: "The same Kanban layout, columns and cards without editing, drag sensors or a data provider. The app supplies its local Spool snapshot server-side." } } },
} satisfies Meta<typeof BoardSnapshot>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Empty: Story = { args: { columns: statuses.map((status) => ({ id: status, label: labels[status], tone: status, items: [] })) } };
export const Large: Story = { args: { columns: statuses.map((status) => ({
  id: status, label: labels[status], tone: status,
  items: Array.from({ length: 150 }, (_, index) => ({ id: `${status}-${index + 1}`, title: `Work item ${index + 1}: a clear, focused task` })),
})) } };
const archived: ArchivedSpoolItem[] = Array.from({ length: 120 }, (_, index) => ({
  key: `attempt-${index}`, id: `TASK-${Math.floor(index / 2)}`, title: `Archived work item ${Math.floor(index / 2)}`,
  status: index % 2 ? "completed" : "failed", updatedAt: new Date(Date.UTC(2026, 8, 1, 0, index)).toISOString(),
}));
export const WithArchive: Story = { args: { ...Large.args, footer: <ArchivedTasks items={archived} /> } };
