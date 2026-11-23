import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { componentPreview } from "../../../.storybook/component-preview";
import { Input } from "./input";
import { Pivot, PivotContent, PivotList, PivotTrigger } from "./pivot";
import { Stack } from "./stack";
import { Text } from "./text";

const panels = <>
  <PivotList label="Work item views">
    <PivotTrigger value="overview">Overview</PivotTrigger>
    <PivotTrigger value="activity">Activity</PivotTrigger>
    <PivotTrigger value="history" disabled>History</PivotTrigger>
  </PivotList>
  <PivotContent value="overview"><Input label="Title" defaultValue="Review keyboard navigation" /></PivotContent>
  <PivotContent value="activity"><Text>No recent activity.</Text></PivotContent>
  <PivotContent value="history"><Text>No history yet.</Text></PivotContent>
</>;
const meta = {
  title: "Components/Pivot", component: Pivot, decorators: [componentPreview],
  args: { defaultValue: "overview", children: panels },
} satisfies Meta<typeof Pivot>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Vertical: Story = { args: { orientation: "vertical" } };
export const Manual: Story = { args: { activationMode: "manual" } };
export const Controlled: Story = {
  render: function ControlledPivot() {
    const [value, setValue] = useState("overview");
    return <Stack><Pivot value={value} onValueChange={setValue}>{panels}</Pivot>
      <Text role="status">Selected: {value}</Text></Stack>;
  },
};
