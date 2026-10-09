import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RunnerWorkflowEditor } from "./runner-workflow-editor";
import { managedFixture } from "./runner-managed-fixtures";

const meta = { title: "Runners/Existing workflows", component: RunnerWorkflowEditor, parameters: { layout: "fullscreen" },
  decorators: [Story => <QueryClientProvider client={new QueryClient()}><Story /></QueryClientProvider>],
  args: { initial: managedFixture("pr-reviewer"), onBack: () => {}, onBrowse: async () => "C:\\Work\\bohemia",
    onBrowseFile: async () => null, agents: ["pr-reviewer", "software-engineer"],
    onSave: async value => ({ ...value, revision: "fixture-saved" }) },
} satisfies Meta<typeof RunnerWorkflowEditor>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Reviewer: Story = {};
export const Livesite: Story = { args: { initial: managedFixture("livesite") } };
export const Updater: Story = { args: { initial: managedFixture("pr-updater") } };
export const Spelling: Story = { args: { initial: managedFixture("spelling") } };
