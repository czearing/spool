import type { Meta, StoryObj } from "@storybook/react-vite";
import { componentPreview } from "../../../.storybook/component-preview";
import { Toolbar, ToolbarButton, ToolbarSeparator } from "./toolbar";
import { Button } from "./button";

const meta = { title: "Components/Toolbar", component: Toolbar, decorators: [componentPreview], args: { "aria-label": "Document actions" } } satisfies Meta<typeof Toolbar>;
export default meta;
type Story = StoryObj<typeof meta>;
const actions = <><ToolbarButton asChild><Button>Download</Button></ToolbarButton>
  <ToolbarButton asChild><Button>Print</Button></ToolbarButton><ToolbarSeparator />
  <ToolbarButton asChild><Button>Share</Button></ToolbarButton></>;
export const Default: Story = { args: { children: actions } };
export const Compact: Story = { args: { children: actions, density: "compact" } };
export const Vertical: Story = { args: { orientation: "vertical", children: actions } };
export const PrimaryAction: Story = { args: { children: <><ToolbarButton asChild><Button>Cancel</Button></ToolbarButton>
  <ToolbarButton asChild><Button variant="primary">Create</Button></ToolbarButton>
  <ToolbarButton asChild><Button variant="primary" disabled>Unavailable</Button></ToolbarButton></> } };
