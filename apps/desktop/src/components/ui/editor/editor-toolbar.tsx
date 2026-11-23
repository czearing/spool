import { useState } from "react";
import { Toolbar, ToolbarButton, ToolbarSeparator } from "../toolbar";
import { Divider } from "../divider";
import { $getSelection, $isRangeSelection, UNDO_COMMAND, REDO_COMMAND } from "lexical";
import { $isCodeNode } from "@lexical/code-core";
import { Undo2, Redo2, ChevronDown, Plus, Ellipsis, ArrowUp, ArrowDown, Copy, Trash2 } from "lucide-react";
import { Button } from "../button";
import { Menu, MenuTrigger, MenuContent, MenuItem, MenuSeparator } from "../menu";
import { Tooltip } from "../tooltip";
import { useEditorSelection } from "./use-editor-selection";
import { blocks, $applyBlock, $changeBlock } from "./blocks";
import { EditorDialog } from "./editor-dialog";
import { SlashMenu } from "./slash-menu";
import { TableActions } from "./table-actions";
import { FormatButtons } from "./format-buttons";
import { SelectionToolbar } from "./selection-toolbar";
import { Popover, PopoverContent, PopoverTrigger } from "../popover";
import styles from "./editor.module.css";

export function EditorToolbar({ contextual = false }: { contextual?: boolean }) {
  const { editor, state, canUndo, canRedo, run } = useEditorSelection();
  const [dialog, setDialog] = useState<"link" | "image" | null>(null);
  const selected = blocks.find((block) => block.id === state.block) || blocks[0];
  const blockAction = (block: typeof blocks[number]) => {
    if (block.id === "image") setDialog("image"); else run(() => { $applyBlock(editor, block.id); });
  };
  const restore = (event: Event) => { event.preventDefault(); editor.focus(); };
  const toolbar = <Toolbar className={styles.toolbar} aria-label="Text formatting">
      <Menu modal={false}><ToolbarButton asChild><MenuTrigger asChild><Button aria-label="Turn into" className={styles.blockButton}>
        <selected.icon aria-hidden="true" /><span>{selected.label}</span><ChevronDown aria-hidden="true" />
      </Button></MenuTrigger></ToolbarButton><MenuContent onCloseAutoFocus={restore}>
        {blocks.slice(0, 11).map((block) => <MenuItem key={block.id} icon={<block.icon />} onSelect={() => blockAction(block)}>{block.label}</MenuItem>)}
      </MenuContent></Menu>
      <ToolbarSeparator />
      <FormatButtons editor={editor} format={state.format} link={state.link} run={run} onLink={() => setDialog("link")} />
      <ToolbarSeparator />
      <Menu modal={false}><ToolbarButton asChild><MenuTrigger asChild><Button aria-label="Insert block"><Plus aria-hidden="true" /></Button></MenuTrigger></ToolbarButton>
        <MenuContent onCloseAutoFocus={(event) => { event.preventDefault(); }}>
          {blocks.slice(9).map((block) => <MenuItem key={block.id} icon={<block.icon />} onSelect={() => blockAction(block)}>{block.label}</MenuItem>)}
        </MenuContent></Menu>
      {state.table && <TableActions run={run} />}
      {state.block === "code" && <Menu modal={false}><ToolbarButton asChild><MenuTrigger asChild><Button aria-label="Code language">{state.language}<ChevronDown aria-hidden="true" /></Button></MenuTrigger></ToolbarButton>
        <MenuContent onCloseAutoFocus={restore}>{["plain", "javascript", "typescript", "json", "css", "html", "python", "bash", "sql"].map((language) =>
          <MenuItem key={language} onSelect={() => run(() => {
            const selection = $getSelection();
            if ($isRangeSelection(selection)) { const node = selection.anchor.getNode().getTopLevelElement(); if ($isCodeNode(node)) node.setLanguage(language); }
          })}>{language}</MenuItem>)}</MenuContent></Menu>}
      <span className={styles.spacer} />
      {[{ label: "Undo", command: UNDO_COMMAND, enabled: canUndo, icon: Undo2 }, { label: "Redo", command: REDO_COMMAND, enabled: canRedo, icon: Redo2 }].map(({ label, command, enabled, icon: Icon }) =>
        <Tooltip key={label} content={label}><ToolbarButton asChild><Button aria-label={label} disabled={!enabled}
          onMouseDown={(event) => event.preventDefault()} onClick={() => editor.dispatchCommand(command, undefined)}><Icon aria-hidden="true" /></Button></ToolbarButton></Tooltip>)}
      <Menu modal={false}><ToolbarButton asChild><MenuTrigger asChild><Button aria-label="Block actions"><Ellipsis aria-hidden="true" /></Button></MenuTrigger></ToolbarButton>
        <MenuContent align="end" onCloseAutoFocus={restore}>
          <MenuItem icon={<ArrowUp />} onSelect={() => run(() => $changeBlock("up"))}>Move block up</MenuItem>
          <MenuItem icon={<ArrowDown />} onSelect={() => run(() => $changeBlock("down"))}>Move block down</MenuItem>
          <MenuItem icon={<Copy />} onSelect={() => run(() => $changeBlock("duplicate"))}>Duplicate block</MenuItem>
          <MenuSeparator /><MenuItem icon={<Trash2 />} onSelect={() => run(() => $changeBlock("delete"))}>Delete block</MenuItem>
        </MenuContent></Menu>
    </Toolbar>;
  return <>
    {contextual ? <Popover><PopoverTrigger asChild>
      <Button className={styles.tools} aria-label="Editing tools"><Ellipsis aria-hidden="true" /></Button>
    </PopoverTrigger><PopoverContent label="Editing tools" align="end" onCloseAutoFocus={restore}>
      {toolbar}
    </PopoverContent></Popover> : <>{toolbar}<Divider /></>}
    <SelectionToolbar range={!dialog && state.block !== "code" ? state.range : ""}>
      <FormatButtons editor={editor} format={state.format} link={state.link} run={run} onLink={() => setDialog("link")} />
    </SelectionToolbar>
    <SlashMenu onImage={() => setDialog("image")} />
    {dialog && <EditorDialog kind={dialog} editor={editor} run={run} initialUrl={dialog === "link" ? state.link : ""} onClose={() => setDialog(null)} />}
  </>;
}
