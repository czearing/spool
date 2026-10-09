import type { ComponentPropsWithRef, ReactNode, Ref } from "react";
import { Columns3, CircleDashed, CircleCheck, CircleAlert } from "lucide-react";
import { StatusDot } from "./ui/status-dot";
import type { Status } from "../lib/work-items";
import { Card } from "./ui/card";
import { Divider } from "./ui/divider";
import { Grid } from "./ui/grid";
import { Stack } from "./ui/stack";
import { Text } from "./ui/text";
import styles from "./board.module.css";
import controls from "./board-controls.module.css";

const icons = { backlog: CircleDashed, "in-progress": CircleDashed, completed: CircleCheck, blocked: CircleAlert };
export function BoardLayout({ header, feedback, footer, children, className = "" }: {
  header: ReactNode; feedback?: ReactNode; footer?: ReactNode; children: ReactNode; className?: string;
}) {
  return <Stack asChild gap={6}><main className={`${styles.board} ${className}`}>
    {header}{feedback}
    <div className={styles.scroll}><Grid asChild columns={4} gap={4}>
      <section id="board-items" tabIndex={-1} className={styles.lanes} aria-label="Work items">{children}</section>
    </Grid></div>
    {footer}
  </main></Stack>;
}
export function BoardColumn({ tone, label, status = tone, count, total = count, actions, footer, children, isOver, ref, scrollable }: {
  tone: Status; label: string; status?: string; count: number; total?: number; actions?: ReactNode;
  footer?: ReactNode; children: ReactNode; isOver?: boolean; ref?: Ref<HTMLElement>; scrollable?: boolean;
}) {
  const Icon = icons[tone];
  return <Stack asChild gap={2}>
    <section ref={ref} className={styles.lane} data-status={status} data-tone={tone} data-over={isOver} aria-label={label}>
      <Stack direction="row" align="center" gap={2} className={styles.laneHeader}>
        <Stack asChild direction="row" align="center" gap={2}><Text asChild variant="heading"><h2 className={styles.heading}>
          {tone === "in-progress" ? <StatusDot tone="info" pulse={total > 0} /> : <Icon aria-hidden="true" />}{label}
        </h2></Text></Stack>
        <Text variant="meta" tone="secondary" tabular aria-label={`${count} of ${total} ${label} tasks`}>
          {count === total ? total : `${count}/${total}`}
        </Text>{actions}
      </Stack>
      <Stack asChild gap={2}><ul className={styles.cards} aria-label={`${label} items`} tabIndex={scrollable ? 0 : undefined}>{children}</ul></Stack>
      {footer}
    </section>
  </Stack>;
}
export function BoardCard({ className = "", ...props }: ComponentPropsWithRef<typeof Card>) {
  return <Card {...props} className={`${styles.workItem} ${className}`} />;
}
export type BoardSnapshotColumn = { id: string; label: string; tone: Status; total?: number; actions?: ReactNode; items: readonly {
  id: string; title: string; agent?: string; progress?: string; error?: string;
}[] };
type SnapshotItem = BoardSnapshotColumn["items"][number];
type OpenTask = (item: SnapshotItem, button: HTMLButtonElement) => void;
function SnapshotCard({ item, onOpenTask }: { item: SnapshotItem; onOpenTask?: OpenTask }) {
  const content = <><Text variant="meta" tone="secondary">{item.id}{item.agent && ` · ${item.agent}`}</Text><Text variant="action">{item.title}</Text>
    {item.progress && <Text variant="meta" tone="secondary" role="status">{item.progress}</Text>}
    {item.error && <Text variant="meta" role="alert">{item.error}</Text>}</>;
  return <Stack asChild gap={1}>{onOpenTask && !item.progress ? <BoardCard asChild><button type="button" aria-label={`Open conversation: ${item.title}`}
    onClick={(event) => onOpenTask(item, event.currentTarget)}>{content}</button></BoardCard> : <BoardCard>{content}</BoardCard>}</Stack>;
}
export function BoardSnapshot({ title, columns, footer, header, feedback, onOpenTask }: {
  title: string; columns: readonly BoardSnapshotColumn[]; footer?: ReactNode; header?: ReactNode; feedback?: ReactNode;
  onOpenTask?: OpenTask;
}) {
  return <BoardLayout className={styles.snapshot} footer={footer} feedback={feedback} header={header ?? <header>
    <Stack direction="row" align="center" gap={3} className={`${controls.toolbar} ${styles.snapshotHeader}`}>
      <Stack asChild direction="row" align="center" gap={2}><Text asChild variant="heading"><h1 className={controls.title}><Columns3 aria-hidden="true" />{title}</h1></Text></Stack>
    </Stack><Divider />
  </header>}>
    {columns.map((column) => <BoardColumn key={column.id} status={column.id} tone={column.tone} label={column.label}
      count={column.items.length} total={column.total} actions={column.actions} scrollable={column.items.length > 0}>
      {column.items.map((item) => <li key={item.id} className={styles.item} data-work-item-id={item.id}>
        <SnapshotCard item={item} onOpenTask={onOpenTask} />
      </li>)}
    </BoardColumn>)}
  </BoardLayout>;
}
