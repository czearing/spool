import { useEffect, useRef, useState } from "react";
import { $getRoot, $getSelection, $getNodeByKey, $isRangeSelection, $setSelection, FORMAT_TEXT_COMMAND,
  type RangeSelection, type LexicalEditor, type TextFormatType } from "lexical";
import { Bold, Italic, Strikethrough, Code, ALargeSmall } from "lucide-react";
import { Button } from "../button";
import { Popover, PopoverContent, PopoverTrigger } from "../popover";
import { Toolbar, ToolbarButton } from "../toolbar";
import { Tooltip } from "../tooltip";
import { Text } from "../text";
import styles from "./chat-input.module.css";

const formats: { value: TextFormatType; label: string; icon: typeof Bold }[] = [
  { value: "bold", label: "Bold", icon: Bold }, { value: "italic", label: "Italic", icon: Italic },
  { value: "strikethrough", label: "Strikethrough", icon: Strikethrough }, { value: "code", label: "Inline code", icon: Code },
];
export function ChatFormatting({ editor, disabled }: { editor: LexicalEditor; disabled?: boolean }) {
  const [open, setOpen] = useState(false), [active, setActive] = useState("");
  const selection = useRef<RangeSelection | null>(null), applying = useRef(false);
  useEffect(() => editor.registerUpdateListener(({ editorState }) => editorState.read(() => {
    const current = $getSelection();
    if (!$isRangeSelection(current)) return;
    selection.current = current.clone();
    const next = formats.filter(({ value }) => current.hasFormat(value)).map(({ value }) => value).join(" ");
    setActive((previous) => previous === next ? previous : next);
  })), [editor]);
  function format(value: TextFormatType) {
    applying.current = true;
    editor.update(() => {
      const saved = selection.current;
      if (saved && $getNodeByKey(saved.anchor.key) && $getNodeByKey(saved.focus.key)) $setSelection(saved.clone());
      else $getRoot().selectEnd();
      editor.dispatchCommand(FORMAT_TEXT_COMMAND, value);
    });
    setOpen(false);
  }
  return <Popover open={open} onOpenChange={setOpen}>
    <Tooltip content="Format text" open={open ? false : undefined}>
      <PopoverTrigger asChild><ToolbarButton asChild><Button disabled={disabled} aria-label="Format text">
        <ALargeSmall aria-hidden />
      </Button></ToolbarButton></PopoverTrigger>
    </Tooltip>
    <PopoverContent label="Message formatting" side="top" align="start" density="compact"
      onCloseAutoFocus={(event) => {
        if (applying.current) { event.preventDefault(); applying.current = false; editor.focus(); }
      }}>
      <Toolbar aria-label="Message formatting" density="compact">
        {formats.map(({ value, label, icon: Icon }) =>
          <ToolbarButton key={value} asChild><Button aria-label={label} title={label} aria-pressed={active.split(" ").includes(value)}
            onClick={() => format(value)}><Icon aria-hidden /></Button></ToolbarButton>
        )}
      </Toolbar>
      <Text asChild variant="meta" tone="muted"><p className={styles.help}>Markdown shortcuts work as you type.<br />Enter to send. Shift+Enter for a new line.</p></Text>
    </PopoverContent>
  </Popover>;
}
