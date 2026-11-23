import type { Meta, StoryObj } from "@storybook/react-vite";
import { componentPreview } from "../../../.storybook/component-preview";
import { Button } from "./button";
import { Tooltip, TooltipProvider } from "./tooltip";

const meta = {
  title: "Components/Tooltip", component: Tooltip,
  decorators: [componentPreview, (Story) => <TooltipProvider><Story /></TooltipProvider>],
  args: { content: "Move this item into the archive.", children: <Button>Archive item</Button> },
} satisfies Meta<typeof Tooltip>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const LongContent: Story = { args: { content: "Archived items remain available. Expand the archive and drag an item into any board column to restore it." } };
export const Bottom: Story = { args: { side: "bottom" } };
