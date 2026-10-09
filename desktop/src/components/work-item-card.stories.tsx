import { DndContext } from "@dnd-kit/core";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { seedItems } from "../lib/seed";
import { WorkItemCard } from "./work-item-card";

const meta = {
  title: "Kanban/Card",
  component: WorkItemCard,
  args: { item: seedItems[0] },
  decorators: [(Story) => <DndContext><div style={{ width: 260, padding: 16 }}><Story /></div></DndContext>],
} satisfies Meta<typeof WorkItemCard>;
export default meta;
export const Default: StoryObj<typeof meta> = {};
