import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "./button";
import { Card } from "./card";
import { Stack } from "./stack";

const meta = {
  title: "Components/Stack",
  component: Stack,
  args: { gap: 3, children: <><Card>First item</Card><Card>Second item</Card><Card>Third item</Card></> },
} satisfies Meta<typeof Stack>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Row: Story = {
  args: { direction: "row", align: "center", gap: 2, wrap: true,
    children: <><Button>Review work</Button><Button variant="primary">Complete work</Button></> },
};
export const AsChild: Story = {
  render: () => <Stack asChild gap={4}><section aria-label="Related work"><Card>First item</Card><Card>Second item</Card></section></Stack>,
};
