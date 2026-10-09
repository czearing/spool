import type { Meta, StoryObj } from "@storybook/react-vite";
import { StatusDot } from "./status-dot";
import { Stack } from "./stack";
import { Text } from "./text";

const meta = { title: "UI/Status dot", component: StatusDot, args: { label: "Working", pulse: true } } satisfies Meta<typeof StatusDot>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Working: Story = {};
export const Static: Story = { args: { pulse: false, label: "Available" } };
export const WithLabel: Story = { render: () => <Stack direction="row" align="center" gap={2}>
  <StatusDot pulse /><Text>Working</Text>
</Stack> };
export const Tones: Story = { render: () => <Stack direction="row" align="center" gap={4}>
  {(["success", "info", "danger", "neutral"] as const).map((tone) => <StatusDot key={tone} tone={tone} label={tone} />)}
</Stack> };
