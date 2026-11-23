import type { Meta, StoryObj } from "@storybook/react-vite";
import { Graph } from "./graph";

const meta = { title: "UI/Graph", component: Graph,
  args: { label: "Task activity", data: [4, 8, 3, 12, 9, 18, 14].map((value, index) => ({ label: `Sep ${24 + index}`, value })) },
  decorators: [(Story) => <div style={{ padding: 24, maxWidth: 800 }}><Story /></div>],
} satisfies Meta<typeof Graph>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Empty: Story = { args: { data: [] } };
export const Zero: Story = { args: { data: [{ label: "Sep 30", value: 0 }, { label: "Oct 1", value: 0 }] } };
export const SinglePoint: Story = { args: { data: [{ label: "Oct 1", value: 3 }] } };
export const MultipleAgents: Story = { args: {
  series: [{ key: "engineer", label: "Engineer" }, { key: "reviewer", label: "Reviewer" }, { key: "writer", label: "Writer" }],
  data: Array.from({ length: 14 }, (_, index) => ({ label: `Sep ${17 + index}`, value: index % 8 + index % 5 + index % 3,
    values: { engineer: index % 8, reviewer: index % 5, writer: index % 3 } })),
} };
export const IdleAgents: Story = { args: {
  series: [{ key: "idle", label: "Idle" }, { key: "engineer", label: "Engineer" }],
  data: [0, 3, 0].map((value, index) => ({ label: `Sep ${28 + index}`, value, values: { idle: 0, engineer: value } })),
} };
