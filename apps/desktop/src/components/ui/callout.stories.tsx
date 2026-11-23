import type { Meta, StoryObj } from "@storybook/react-vite";
import { componentPreview } from "../../../.storybook/component-preview";
import { Callout } from "./callout";
import { Stack } from "./stack";
import { Text } from "./text";

const meta = { title: "Components/Callout", component: Callout, decorators: [componentPreview],
  args: { "aria-label": "Project note", children: <Stack gap={2}>
    <Text variant="action">Keep the context close.</Text><Text>A reusable note surface for any page, not just editable documents.</Text>
  </Stack> },
} satisfies Meta<typeof Callout>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
