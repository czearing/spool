import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { componentPreview } from "../../../.storybook/component-preview";
import { DropIndicator } from "./drop-indicator";
import { Card } from "./card";
import { Stack } from "./stack";
import { Text } from "./text";

const meta = { title: "Components/DropIndicator", component: DropIndicator, decorators: [componentPreview],
  render: function AnchoredExample({ orientation, placement }) {
    const [anchor, setAnchor] = useState<HTMLDivElement | null>(null);
    return <Stack gap={6}><Text>Insertion markers share the same presentation across boards, lists, and documents.</Text>
      <Card ref={setAnchor}>Drop target</Card>{anchor && <DropIndicator {...{ anchor, orientation, placement }} />}
    </Stack>;
  },
} satisfies Meta<typeof DropIndicator>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Horizontal: Story = {};
export const Vertical: Story = { args: { orientation: "vertical", placement: "after" } };
