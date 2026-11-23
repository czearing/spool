import type { Meta, StoryObj } from "@storybook/react-vite";
import { Card } from "./card";
import { Grid } from "./grid";

const meta = {
  title: "Components/Grid",
  component: Grid,
  args: { columns: 2, gap: 4, children: <><Card>First item</Card><Card>Second item</Card><Card>Third item</Card><Card>Fourth item</Card></> },
} satisfies Meta<typeof Grid>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const FourColumns: Story = { args: { columns: 4 } };
export const AsChild: Story = {
  render: () => <Grid asChild columns={2}><section aria-label="Related work"><Card>First item</Card><Card>Second item</Card></section></Grid>,
};
