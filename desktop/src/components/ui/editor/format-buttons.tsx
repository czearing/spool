import { ToolbarButton } from "../toolbar";
import { FORMAT_TEXT_COMMAND, type LexicalEditor, type TextFormatType } from "lexical";
import { Bold, Italic, Underline, Strikethrough, Code, Highlighter, Link } from "lucide-react";
import { Button } from "../button";
import { Tooltip } from "../tooltip";
const formats: { type: TextFormatType; label: string; icon: typeof Bold }[] = [
  { type: "bold", label: "Bold", icon: Bold }, { type: "italic", label: "Italic", icon: Italic },
  { type: "underline", label: "Underline", icon: Underline }, { type: "strikethrough", label: "Strikethrough", icon: Strikethrough },
  { type: "code", label: "Inline code", icon: Code }, { type: "highlight", label: "Highlight", icon: Highlighter },
];
export function FormatButtons({ editor, format, link, run, onLink }: {
  editor: LexicalEditor; format: string; link: string; run: (action: () => void) => void; onLink: () => void;
}) {
  return <>
    {formats.map(({ type, label, icon: Icon }) => <Tooltip key={type} content={label}>
      <ToolbarButton asChild><Button aria-label={label} aria-pressed={format.split(" ").includes(type)}
        onMouseDown={(event) => event.preventDefault()} onClick={() => run(() => { editor.dispatchCommand(FORMAT_TEXT_COMMAND, type); })}>
        <Icon aria-hidden="true" /></Button></ToolbarButton>
    </Tooltip>)}
    <Tooltip content="Link"><ToolbarButton asChild><Button aria-label="Edit link" aria-pressed={!!link}
      onMouseDown={(event) => event.preventDefault()} onClick={onLink}><Link aria-hidden="true" /></Button></ToolbarButton></Tooltip>
  </>;
}
