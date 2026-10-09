import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState, type MouseEvent } from "react";
import { BookOpen, CircleHelp, FileText, Folder, Inbox, LayoutGrid, ListTodo, Settings, Users } from "lucide-react";
import { Sidebar, SidebarAccordion, SidebarBranch, SidebarGroup, SidebarItem, SidebarSwitcher } from "./sidebar";
import { Avatar } from "./avatar";
import { Button } from "./button";
import { Stack } from "./stack";
import { Text } from "./text";
import { ActiveInstances } from "../active-instances";
import { AgentActionsMenu } from "../agent-actions-menu";
import styles from "./sidebar.stories.module.css";

function SidebarExample({ many = false, nested = false, collapsed = false }: { many?: boolean; nested?: boolean; collapsed?: boolean }) {
  const [selected, setSelected] = useState("Work items");
  const [workspace, setWorkspace] = useState("Spool");
  function select(event: MouseEvent<HTMLAnchorElement>, label: string) {
    if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); setSelected(label);
  }
  const item = (label: string, Icon = FileText, badge?: number) => <SidebarItem key={label}
    href={`#${label.toLowerCase().replaceAll(" ", "-")}`} active={selected === label} icon={<Icon />} badge={badge}
    onClick={(event) => select(event, label)} title={label}>{label}</SidebarItem>;
  return <div className={styles.preview}>
    <Sidebar label="Workspace navigation" header={
      <SidebarSwitcher label="Switch workspace" value={workspace} onValueChange={setWorkspace}
        options={["Spool", "Personal"].map((name) => ({ value: name, label: name }))} />
    } footer={<Stack gap={3}>
      <SidebarGroup>{item("Help & feedback", CircleHelp)}{item("Settings", Settings)}</SidebarGroup>
      <Stack direction="row" gap={2} align="center" className={styles.profile}>
        <Avatar name="Alex Morgan" fallback="AM" size="small" /><Text variant="action">Alex Morgan</Text>
      </Stack>
    </Stack>}>
      <SidebarGroup>{item("Inbox", Inbox, 3)}{item("Work items", ListTodo, 24)}{item("Overview", LayoutGrid)}</SidebarGroup>
      <SidebarGroup label="Workspace">{item("Projects", Folder)}{item("Members", Users)}</SidebarGroup>
      <SidebarGroup label="Favorites" collapsible defaultOpen={!collapsed}>
        {item("Getting started", BookOpen)}{item("Release planning")}
        {nested && <SidebarBranch label="Design" defaultOpen>
          {item("Component library")}
          <SidebarBranch label="Foundations">{item("Typography")}{item("Spacing")}</SidebarBranch>
          <SidebarBranch label="Private project" disabled>{item("Private notes")}</SidebarBranch>
        </SidebarBranch>}
      </SidebarGroup>
      {many && <SidebarGroup label="Documents">
        {Array.from({ length: 40 }, (_, index) => item(`Document ${index + 1}`))}
        {item("A very long document title that should never push the sidebar wider")}
      </SidebarGroup>}
    </Sidebar>
    <main className={styles.canvas}><Stack gap={2}>
      <Text variant="meta" tone="secondary">{workspace} / Workspace</Text>
      <Text asChild variant="heading"><h1>{selected}</h1></Text>
      <Text tone="secondary">A place for focused work.</Text>
    </Stack></main>
  </div>;
}

const meta = {
  title: "Components/Sidebar", component: Sidebar, args: { label: "Workspace navigation" },
  parameters: { docs: { description: { component: [
    "Quiet, grouped navigation informed by [Linear](https://linear.app/docs/favorites) and [Notion](https://www.notion.com/help/navigate-with-the-sidebar).",
    "Compose SidebarGroup, native SidebarItem links, and Radix-backed SidebarBranch disclosures. Header/footer stay fixed while navigation scrolls.",
    "SidebarSwitcher is the shared avatar/menu header used here and in the app; SidebarItem accepts linkComponent for router links without changing its presentation.",
    "No router, persistence, global keyboard listeners, or application state is owned by the component. Active links use aria-current; navigation uses native Tab/Enter, not menu arrow-key semantics.",
    "Override --size-sidebar for width. Give Sidebar a height-constrained parent. Collapsible groups accept open/onOpenChange or defaultOpen.",
    "Nest branches inside groups or other branches; item icons are decorative and badges are included in accessible link names. Collapsed content unmounts; control branch state externally if it must survive an ancestor closing.",
  ].join("\n\n") } } },
  render: () => <SidebarExample />,
} satisfies Meta<typeof Sidebar>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Nested: Story = { render: () => <SidebarExample nested /> };
export const CollapsedSections: Story = { render: () => <SidebarExample collapsed /> };
export const Overflow: Story = { render: () => <SidebarExample many /> };
export const Agents: Story = {
  render: () => <div className={styles.preview}><Sidebar label="Project navigation" header={<Text variant="heading">Project</Text>}>
    <SidebarGroup><SidebarItem href="#home" icon={<LayoutGrid />}>Home</SidebarItem><SidebarItem href="#tasks" icon={<ListTodo />}>Tasks</SidebarItem></SidebarGroup>
    <SidebarAccordion label="Agents" badge={<ActiveInstances count={2} name="Agents" />}>
      {["software-engineer", "reviewer", "tech-writer"].map((agent) =>
        <SidebarItem key={agent} href={`#${agent}`} icon={<Users />} active={agent === "software-engineer"}
          actions={<AgentActionsMenu agent={agent} compact label={`${agent} actions`} editLink={<a href="#prompt">Edit prompt</a>} onDelete={() => {}} />}
          badge={agent === "software-engineer" ? <ActiveInstances count={2} name={agent} /> : undefined}>{agent}</SidebarItem>)}
    </SidebarAccordion>
  </Sidebar></div>,
};
export const Controlled: Story = {
  render: function ControlledGroup() {
    const [open, setOpen] = useState(true);
    return <div className={styles.preview}><Sidebar label="Controlled navigation" header={<Text variant="heading">Library</Text>}
      footer={<Button onClick={() => setOpen(!open)}>Toggle favorites</Button>}>
      <SidebarGroup label="Favorites" collapsible open={open} onOpenChange={setOpen}>
        <SidebarItem href="#guide" icon={<BookOpen />}>Guide</SidebarItem>
      </SidebarGroup>
    </Sidebar></div>;
  },
};
