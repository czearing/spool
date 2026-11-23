import type { Meta, StoryObj } from "@storybook/react-vite";
import { componentPreview } from "../../../.storybook/component-preview";
import { Divider } from "./divider";
import { Stack } from "./stack";
import { Text } from "./text";

const meta = { title: "Components/Divider", component: Divider, decorators: [componentPreview] } satisfies Meta<typeof Divider>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = { render: () => <Stack gap={4}><Text variant="heading">Overview</Text><Divider /><Text>Additional context</Text></Stack> };
export const Semantic: Story = { render: () => <Stack gap={4}><Text>First section</Text><Divider decorative={false} /><Text>Second section</Text></Stack> };
export const Vertical: Story = { render: () => <Stack direction="row" align="stretch" gap={4}>
  <Text>Created<br />September 28</Text><Divider orientation="vertical" decorative={false} /><Text>Draft</Text>
</Stack> };
