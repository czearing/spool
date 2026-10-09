import { $insertTableRowAtSelection, $insertTableColumnAtSelection, $deleteTableRowAtSelection, $deleteTableColumnAtSelection } from "@lexical/table";
import { ChevronDown, Table2 } from "lucide-react";
import { Button } from "../button";
import { ToolbarButton } from "../toolbar";
import { Menu, MenuTrigger, MenuContent, MenuItem, MenuSeparator } from "../menu";
export function TableActions({ run }: { run: (action: () => void) => void }) {
  const actions = [
    ["Insert row above", () => $insertTableRowAtSelection(false)], ["Insert row below", () => $insertTableRowAtSelection(true)],
    ["Insert column left", () => $insertTableColumnAtSelection(false)], ["Insert column right", () => $insertTableColumnAtSelection(true)],
    ["Delete row", $deleteTableRowAtSelection], ["Delete column", $deleteTableColumnAtSelection],
  ] as const;
  return <Menu modal={false}><ToolbarButton asChild><MenuTrigger asChild><Button aria-label="Table actions"><Table2 aria-hidden="true" /><ChevronDown aria-hidden="true" /></Button></MenuTrigger></ToolbarButton>
    <MenuContent onCloseAutoFocus={(event) => event.preventDefault()}>
      {actions.map(([label, action], index) => <span key={label} style={{ display: "contents" }}>
        {index === 4 && <MenuSeparator />}<MenuItem onSelect={() => run(action)}>{label}</MenuItem>
      </span>)}
    </MenuContent></Menu>;
}
