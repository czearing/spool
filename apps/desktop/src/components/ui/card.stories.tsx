import type { Meta, StoryObj } from "@storybook/react-vite";
import { Card } from "./card";

const meta = {
  title: "Components/Card",
  component: Card,
  args: { children: "Card content" },
  decorators: [(Story) => <div style={{ width: 280, padding: 16 }}><Story /></div>],
} satisfies Meta<typeof Card>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const AsButton: Story = {
  render: () => <Card asChild><button type="button">Card action</button></Card>,
};
