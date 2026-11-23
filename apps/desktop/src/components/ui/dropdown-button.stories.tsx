import type { Meta, StoryObj } from "@storybook/react-vite";
import { componentPreview } from "../../../.storybook/component-preview";
import { DropdownButton } from "./dropdown-button";
import { Menu, MenuContent, MenuItem } from "./menu";

const meta = {
  title: "Components/Dropdown button", component: DropdownButton, decorators: [componentPreview],
  args: { children: "Actions" },
  render: (args) => <Menu><DropdownButton {...args} /><MenuContent><MenuItem>Open item</MenuItem><MenuItem>Archive item</MenuItem></MenuContent></Menu>,
} satisfies Meta<typeof DropdownButton>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Primary: Story = { args: { variant: "primary" } };
export const Disabled: Story = { args: { disabled: true } };
