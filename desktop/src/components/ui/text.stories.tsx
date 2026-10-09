import type { Meta, StoryObj } from "@storybook/react-vite";
import { Accordion } from "./accordion";
import { Button } from "./button";
import { Card } from "./card";
import { List } from "./list";
import { Text } from "./text";
import { Stack } from "./stack";
import styles from "./text.stories.module.css";

const meta = {
  title: "Components/Text",
  component: Text,
  args: { children: "Clear, readable work items." },
} satisfies Meta<typeof Text>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const AsChild: Story = {
  render: () => <Text asChild variant="heading"><h2>Work items</h2></Text>,
};
export const Specimen: Story = {
  render: () => (
    <Stack gap={4} className={styles.specimen}>
      <Text asChild variant="heading"><h2>Organize this - 600</h2></Text>
      <Text asChild><p>Read this - 400. Il1 O0 rn. José, Zoë, Łukasz, Nguyễn. Ελληνικά, Кириллица, 日本語.</p></Text>
      <Text asChild variant="action"><p>Act on this - 500</p></Text>
      <Text variant="meta" tone="secondary" tabular>Supplementary counts: 001 / 128</Text>
      <Stack direction="row" gap={2} wrap><Button>Review work</Button><Button variant="primary">Complete work</Button></Stack>
      <Card>Generic content stays regular, rather than competing with task titles.</Card>
      <Card asChild><button type="button"><Text variant="action">Review a longer task title that wraps naturally instead of hiding important work behind an ellipsis.</Text></button></Card>
      <Accordion title={<>Archive <Text variant="meta" tone="secondary" tabular>(2)</Text></>} defaultOpen>
        <List label="Typography archive" items={[{ id: 1, name: "Review José's proposal" }, { id: 2, name: "Document keyboard navigation" }]}
          getRowKey={(item) => item.id} columns={[
            { key: "title", header: "Work item", cell: (item) => <Text asChild><p>{item.name}</p></Text> },
            { key: "status", header: "Status", cell: () => <Text tone="secondary">Completed</Text> },
            { key: "date", header: "Finished", cell: () => <Text tabular>2026-09-25</Text> },
          ]} />
      </Accordion>
      <Text asChild tone="muted"><p>Drop items here.</p></Text>
    </Stack>
  ),
};
