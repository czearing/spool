import { useRef, useState, type Ref } from "react";
import { Columns3, ListFilter, ArrowDownUp, Search, X, Plus } from "lucide-react";
import type { useBoardControls } from "../hooks/use-board-controls";
import { boardSorts, isBoardSort } from "../lib/board-items";
import { labels, statuses } from "../lib/work-items";
import { Button } from "./ui/button";
import { Menu, MenuTrigger, MenuContent, MenuLabel, MenuCheckboxItem, MenuItem, MenuSeparator, MenuRadioGroup, MenuRadioItem } from "./ui/menu";
import { Text } from "./ui/text";
import { Tooltip } from "./ui/tooltip";
import { Input } from "./ui/input";
import { Divider } from "./ui/divider";
import { Toolbar, ToolbarButton } from "./ui/toolbar";
import { Stack } from "./ui/stack";
import styles from "./board-controls.module.css";

export function BoardToolbar({ controls, onAdd, adding, title = "Board", statusLabels = labels, defaultOrderLabel = "Manual order", addButtonRef }: {
  controls: ReturnType<typeof useBoardControls>; onAdd: () => void; adding: boolean;
  title?: string; statusLabels?: typeof labels; defaultOrderLabel?: string; addButtonRef?: Ref<HTMLButtonElement>;
}) {
  const [searchOpen, setSearchOpen] = useState(false);
  const searchButton = useRef<HTMLButtonElement>(null);
  return <header><Stack direction="row" align="center" justify="space-between" gap={3} wrap className={styles.toolbar}>
    <Stack asChild direction="row" align="center" gap={2}><Text asChild variant="heading"><h1 className={styles.title}><Columns3 aria-hidden="true" />{title}</h1></Text></Stack>
    <Stack asChild direction="row" align="center" gap={1} wrap><Toolbar className={styles.tools} aria-label="Board actions" density="compact">
      {(searchOpen || controls.query) && <div className={styles.search}>
        <Input label="Search work items" labelHidden density="compact" type="search" autoFocus placeholder="Search tasks..." value={controls.query}
          onChange={(event) => controls.setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault(); controls.setQuery(""); setSearchOpen(false); searchButton.current?.focus();
            }
          }} />
      </div>}
      <Tooltip content="Search tasks"><ToolbarButton asChild><Button ref={searchButton} className={styles.quiet} aria-label="Search board"
        aria-expanded={searchOpen || !!controls.query} onClick={() => {
          if (searchOpen || controls.query) { controls.setQuery(""); setSearchOpen(false); } else setSearchOpen(true);
        }}><Search aria-hidden="true" /></Button></ToolbarButton></Tooltip>
      <Menu modal={false}><ToolbarButton asChild><MenuTrigger asChild><Button className={styles.quiet} data-active={controls.selected.length > 0}
        aria-label={controls.selected.length ? `Filter by status (${controls.selected.length})` : "Filter by status"}>
        <ListFilter aria-hidden="true" /><span>Filter</span>{controls.selected.length > 0 && <span className={styles.indicator} />}
      </Button></MenuTrigger></ToolbarButton><MenuContent align="end">
        <MenuLabel>Status</MenuLabel>
        {statuses.map((status) => <MenuCheckboxItem key={status} checked={controls.selected.includes(status)}
          onSelect={(event) => event.preventDefault()} onCheckedChange={() => controls.toggleStatus(status)}>{statusLabels[status]}</MenuCheckboxItem>)}
        <MenuSeparator /><MenuItem disabled={!controls.hasFilters} onSelect={controls.clearFilters}>Clear filters</MenuItem>
      </MenuContent></Menu>
      <Menu modal={false}><ToolbarButton asChild><MenuTrigger asChild><Button className={styles.quiet} data-active={controls.sort !== "manual"} aria-label="Sort work items">
        <ArrowDownUp aria-hidden="true" /><span>Sort</span>{controls.sort !== "manual" && <span className={styles.indicator} />}
      </Button></MenuTrigger></ToolbarButton><MenuContent align="end">
        <MenuLabel>Sort by</MenuLabel>
        <MenuRadioGroup value={controls.sort} onValueChange={(value) => { if (isBoardSort(value)) controls.setSort(value); }}>
          {boardSorts.map((sort) => <MenuRadioItem key={sort.value} value={sort.value}>{sort.value === "manual" ? defaultOrderLabel : sort.label}</MenuRadioItem>)}
        </MenuRadioGroup>
      </MenuContent></Menu>
      {controls.hasFilters && <Tooltip content="Clear search and filters"><ToolbarButton asChild><Button className={styles.quiet}
        aria-label="Clear search and filters" onClick={controls.clearFilters}><X aria-hidden="true" /></Button></ToolbarButton></Tooltip>}
      <ToolbarButton asChild><Button ref={addButtonRef} variant="primary" onClick={onAdd} disabled={adding}><Plus aria-hidden="true" />New</Button></ToolbarButton>
    </Toolbar></Stack>
  </Stack><Divider /></header>;
}
