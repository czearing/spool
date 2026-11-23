import type { Meta, StoryObj } from "@storybook/react-vite";
import { componentPreview } from "../../../.storybook/component-preview";
import { Avatar } from "./avatar";
import { Stack } from "./stack";
import { Text } from "./text";

const image = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80" viewBox="0 0 80 80"><rect width="80" height="80" fill="#e5e5e5"/><circle cx="40" cy="29" r="14" fill="#525252"/><path d="M12 80V70a28 28 0 0 1 56 0v10" fill="#525252"/></svg>')}`;
const meta = {
  title: "Components/Avatar", component: Avatar, decorators: [componentPreview],
  args: { name: "Jordan Rivers", fallback: "JR" },
} satisfies Meta<typeof Avatar>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Image: Story = { args: { src: image } };
export const ImageFailure: Story = { args: { src: "data:image/png;base64,invalid" } };
export const Sizes: Story = {
  render: () => <Stack direction="row" align="center" gap={4} wrap>
    <Avatar name="Jordan Rivers" fallback="JR" size="small" />
    <Avatar name="Sam Lee" fallback="SL" />
    <Avatar name="Alex Morgan" fallback="AM" size="large" />
    <Text>Project collaborators</Text>
  </Stack>,
};
