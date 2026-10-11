import type { Meta, StoryObj } from "@storybook/react-vite";
import { AgentImportPane } from "./agent-import-pane";
import { AgentCreateDialogView } from "./agent-create-dialog";
import { Button } from "./ui/button";

const catalog = { projects: [
  { id: "bohemia", name: "Bohemia", agents: ["designer", "perf", "prompt-engineer", "software-engineer-general"] },
  { id: "research", name: "Research", agents: ["researcher"] },
] };
const meta = { title: "Agents/Import from project", component: AgentImportPane, parameters: { layout: "centered" },
  args: { id: "import-story", catalog, onSelect: () => {}, onImport: () => {}, onReload: () => {} },
  decorators: [Story => <div style={{ width: "min(32rem, calc(100vw - 32px))" }}><Story /></div>],
} satisfies Meta<typeof AgentImportPane>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Library: Story = {};
export const Preview: Story = { args: { source: { project: "bohemia", projectName: "Bohemia", agent: "designer" },
  preview: { id: "designer", prompt: "# Product designer\n\nResearch the audience, inspect existing tokens and explain the recommended direction.", revision: "example" } } };
export const Empty: Story = { args: { catalog: { projects: [] } } };
export const Loading: Story = { args: { loading: true } };
export const Error: Story = { args: { error: "The source project is unavailable. Nothing has been imported." } };
export const Saving: Story = { args: { ...Preview.args, pending: true } };
export const AddAgent: Story = { render: args => <AgentCreateDialogView open onOpenChange={() => {}} options={[]} onCreate={() => {}}
  importPanel={{ pending: false, content: <AgentImportPane {...args} />,
    footer: <Button variant="primary">Import agent</Button> }} /> };
