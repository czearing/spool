import type { Meta, StoryObj } from "@storybook/react-vite";
import { Timestamp } from "./timestamp";

const meta = {
  title: "Components/Timestamp", component: Timestamp,
  args: { value: "2026-09-29T20:45:38Z" },
  parameters: { docs: { description: { component: "A consistent UTC date and time. Label the surrounding column or field with UTC; missing timestamps are explicitly marked." } } },
} satisfies Meta<typeof Timestamp>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const NotRecorded: Story = { args: { value: null } };
