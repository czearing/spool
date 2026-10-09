import type { Meta, StoryObj } from "@storybook/react-vite";
import { Accordion } from "./accordion";
import { Button } from "./button";

const meta = {
  title: "Components/Accordion",
  component: Accordion,
  args: { title: "Details", children: <Button>Content action</Button> },
  decorators: [(Story) => <div style={{ maxWidth: 480, padding: 16 }}><Story /></div>],
} satisfies Meta<typeof Accordion>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Expanded: Story = { args: { defaultOpen: true } };
export const LongContent: Story = {
  args: {
    title: "A longer heading that can wrap without crowding the chevron",
    children: <><p>Keep related work together without taking attention away from the board.</p><Button>Content action</Button></>,
  },
};
