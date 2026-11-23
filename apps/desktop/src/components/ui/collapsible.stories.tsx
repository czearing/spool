import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { componentPreview } from "../../../.storybook/component-preview";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "./collapsible";
import { Button } from "./button";
import { Text } from "./text";
import { Stack } from "./stack";

const parts = <><CollapsibleTrigger>Project details</CollapsibleTrigger>
  <CollapsibleContent><Text>Supporting context stays here until you need it.</Text></CollapsibleContent></>;
const meta = { title: "Components/Collapsible", component: Collapsible, decorators: [componentPreview],
  args: { children: parts },
} satisfies Meta<typeof Collapsible>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Open: Story = { args: { defaultOpen: true } };
export const Disabled: Story = { args: { disabled: true } };
export const Composed: Story = { args: { children: <>
  <CollapsibleTrigger asChild><Button>Project details</Button></CollapsibleTrigger>
  <CollapsibleContent><Text>Supporting context stays here until you need it.</Text></CollapsibleContent>
</> } };
export const Controlled: Story = {
  render: function ControlledDisclosure() {
    const [open, setOpen] = useState(false);
    return <Stack><Collapsible open={open} onOpenChange={setOpen}>{parts}</Collapsible>
      <Text role="status">{open ? "Expanded" : "Collapsed"}</Text></Stack>;
  },
};
