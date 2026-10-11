import type { Meta, StoryObj } from "@storybook/react-vite";
import { NavigationGuard } from "./navigation-guard";
import { RunnerSidebarItems } from "./runner-sidebar";
import { Sidebar, SidebarAccordion } from "./ui/sidebar";

const meta = {
  title: "Runners/Sidebar", component: RunnerSidebarItems,
  parameters: { layout: "fullscreen", nextjs: { appDirectory: true } },
  args: { project: "bohemia", pathname: "/bohemia/runners/livesite",
    data: { configured: true, runners: [{ id: "pr-reviewer", name: "PR reviewer" }, { id: "livesite", name: "Livesite" }] }, onRetry: () => {} },
  decorators: [Story => <NavigationGuard><div style={{ height: "100dvh" }}>
    <Sidebar label="Project navigation"><SidebarAccordion label="Runners" defaultOpen><Story /></SidebarAccordion></Sidebar>
  </div></NavigationGuard>],
} satisfies Meta<typeof RunnerSidebarItems>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Empty: Story = { args: { data: { configured: true, runners: [] } } };
export const Unavailable: Story = { args: { error: "Runner status is unavailable." } };
