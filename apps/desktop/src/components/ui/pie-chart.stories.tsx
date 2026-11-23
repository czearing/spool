import type { Meta, StoryObj } from "@storybook/react-vite";
import { PieChart } from "./pie-chart";
import { formatUsd } from "../../lib/currency";

const meta = { title: "UI/Pie chart", component: PieChart,
  args: { label: "Current status", data: [
    { label: "Completed", value: 42, tone: "success" }, { label: "In progress", value: 8, tone: "info" },
    { label: "Incoming", value: 12, tone: "neutral" }, { label: "Failed", value: 3, tone: "danger" },
  ] },
  decorators: [(Story) => <div style={{ padding: 24, maxWidth: 360 }}><Story /></div>],
} satisfies Meta<typeof PieChart>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Empty: Story = { args: { data: [] } };
export const Zero: Story = { args: { data: [{ label: "Completed", value: 0 }] } };
export const SingleStatus: Story = { args: { data: [{ label: "Completed", value: 42, tone: "success" }] } };
export const Costs: Story = { args: { label: "Cost by agent", formatValue: formatUsd,
  data: [{ label: "engineer", value: 12.5 }, { label: "reviewer", value: 3.75 }, { label: "writer", value: 0.001 }] } };
