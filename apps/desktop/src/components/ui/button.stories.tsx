import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "./button";

const meta = {
  title: "Components/Button",
  component: Button,
  args: { children: "Button" },
  parameters: { layout: "centered" },
} satisfies Meta<typeof Button>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Primary: Story = { args: { variant: "primary" } };
export const PrimaryDisabled: Story = { args: { variant: "primary", disabled: true } };
export const Disabled: Story = { args: { disabled: true } };
export const AsLink: Story = {
  render: () => <Button asChild><a href="#example">Link</a></Button>,
};
