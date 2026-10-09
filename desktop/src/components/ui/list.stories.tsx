import type { Meta, StoryObj } from "@storybook/react-vite";
import { CheckCircle2, Circle, CircleAlert, CircleDashed, FileText } from "lucide-react";
import { useState } from "react";
import { wideComponentPreview } from "../../../.storybook/component-preview";
import { Button } from "./button";
import { List, type ListColumn, type ListSort } from "./list";
import { ListCell } from "./list-cell";
import { Stack } from "./stack";
import { Text } from "./text";

type Item = { id: string; title: string; owner: string; status: keyof typeof statusIcons; estimate?: number; updated?: Date };
const items: Item[] = [
  { id: "a", title: "Task 10", owner: "Design system", status: "Completed", estimate: 2, updated: new Date("2026-09-20T12:00:00Z") },
  { id: "b", title: "Task 2", owner: "Accessibility", status: "In progress", estimate: 10, updated: new Date("2026-09-22T12:00:00Z") },
  { id: "c", title: "Task 1", owner: "Documentation", status: "Backlog" },
  { id: "d", title: "Task 2", owner: "Performance", status: "Blocked", estimate: 2, updated: new Date("2026-09-19T12:00:00Z") },
];
const date = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" });
const statusIcons = { Completed: CheckCircle2, "In progress": CircleDashed, Backlog: Circle, Blocked: CircleAlert };
const columns: ListColumn<Item>[] = [
  { key: "title", header: "Work item", icon: <FileText />, rowHeader: true, width: "40%", sortValue: (item) => item.title,
    cell: (item) => <ListCell icon={<FileText />} description={item.owner}>{item.title}</ListCell> },
  { key: "status", header: "Status", width: "24%", sortValue: (item) => item.status,
    cell: (item) => {
      const Icon = statusIcons[item.status];
      return <ListCell icon={<Icon />}>{item.status}</ListCell>;
    } },
  { key: "estimate", header: "Points", align: "end", width: "16%", sortValue: (item) => item.estimate,
    cell: (item) => item.estimate ?? "—" },
  { key: "updated", header: "Updated", width: "20%", sortValue: (item) => item.updated,
    cell: (item) => item.updated ? date.format(item.updated) : "—" },
];
const meta = {
  title: "Components/List",
  component: List<Item>,
  decorators: [wideComponentPreview],
  args: { label: "Work items", items, columns, minWidth: "var(--size-list)", getRowKey: (item: Item) => item.id },
} satisfies Meta<typeof List<Item>>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = { args: { preferencesKey: "storybook-list", items: items.map((item, index) => ({
  ...item, title: ["Document component guidelines", "Improve keyboard navigation", "Write the onboarding guide", "Reduce initial bundle size"][index],
})) } };
export const Sorting: Story = {};
export const RememberedLayout: Story = { args: { preferencesKey: "storybook-work-items" } };
export const ResizeLimits: Story = {
  args: { columns: columns.map((column) => ({ ...column, minWidth: 100, maxWidth: 480, resizable: column.key !== "updated" })) },
};
export const Compact: Story = { args: { density: "compact" } };
export const Plain: Story = { args: { appearance: "plain" } };
export const Empty: Story = { args: { items: [], emptyMessage: "No archived work. Drag an item here to archive it." } };
export const Loading: Story = { args: { items: [], loading: true } };
export const Refreshing: Story = { args: { loading: true } };
export const Error: Story = { args: { error: "Work items could not be loaded. Please try again." } };
export const InitiallySorted: Story = { args: { defaultSort: { key: "estimate", direction: "desc" } } };
export const LongContent: Story = {
  args: { items: [{ ...items[0], title: "A long work item title. ".repeat(30) }] },
};
export const CustomOrder: Story = {
  args: { columns: columns.map((column) => column.key === "status" ? {
    ...column, compare: (a, b) => ["Backlog", "In progress", "Completed", "Blocked"].indexOf(a.status)
      - ["Backlog", "In progress", "Completed", "Blocked"].indexOf(b.status),
  } : column) },
};
export const Controlled: Story = {
  render: function ControlledList(args) {
    const [sort, setSort] = useState<ListSort>(null);
    return <Stack gap={3}>
      <Button onClick={() => setSort(null)}>Reset sorting</Button>
      <List {...args} sort={sort} onSortChange={setSort} />
      <Text variant="meta" tone="secondary">{sort ? `${sort.key}: ${sort.direction}` : "Original order"}</Text>
    </Stack>;
  },
};
export const ManualSorting: Story = {
  render: function ManualList(args) {
    const [sort, setSort] = useState<ListSort>(null);
    return <Stack gap={3}>
      <Text tone="secondary">Manual mode preserves supplied row order. Use this state in your server query.</Text>
      <List {...args} manualSorting sort={sort} onSortChange={setSort} />
      <Text variant="meta">{sort ? `Requested: ${sort.key} ${sort.direction}` : "No sort requested"}</Text>
    </Stack>;
  },
};
export const WithActions: Story = {
  render: function ActionList(args) {
    const [message, setMessage] = useState("");
    return <Stack gap={3}>
      <List {...args} columns={[...columns.slice(0, 2).map((column) => ({ ...column, width: column.key === "title" ? "52%" : "24%" })), {
        key: "actions", header: "Actions", align: "end", width: "24%",
        cell: (item) => <Button aria-label={`Open item: ${item.title}, ${item.owner}`}
          onClick={() => setMessage(`Opened ${item.owner}`)}>Open item</Button>,
      }]} />
      <Text role="status">{message}</Text>
    </Stack>;
  },
};
