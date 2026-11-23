import type { Meta, StoryObj } from "@storybook/react-vite";
import { WorkItemsProvider } from "../hooks/use-work-items";
import { Board } from "./board";
import { seedItems } from "../lib/seed";
import type { WorkItem } from "../lib/work-items";

const meta = {
  id: "workroom-board",
  title: "Kanban/Board",
  component: Board,
  parameters: { docs: { description: { component: "One status board with inline creation, search, status filters, title sorting, and a collapsed archive. No additional views or database settings." } } },
  decorators: [(Story) => <WorkItemsProvider><Story /></WorkItemsProvider>],
} satisfies Meta<typeof Board>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Empty: Story = { render: () => <WorkItemsProvider items={[]}><Board /></WorkItemsProvider> };
export const WithArchive: Story = {
  render: () => <WorkItemsProvider items={[...seedItems, ...seedItems.slice(0, 2).map<WorkItem>((item) => ({
    ...item, id: `archived-${item.id}`, status: "completed", archived: true,
  }))]}><Board /></WorkItemsProvider>,
};
