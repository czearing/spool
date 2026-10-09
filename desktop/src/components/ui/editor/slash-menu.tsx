import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { $getSelection, $isRangeSelection } from "lexical";
import { $isCodeNode } from "@lexical/code-core";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { LexicalTypeaheadMenuPlugin, MenuOption, useBasicTypeaheadTriggerMatch } from "@lexical/react/LexicalTypeaheadMenuPlugin";
import { blocks, $applyBlock } from "./blocks";
import { CommandList, CommandItem, CommandEmpty } from "../command-list";
import styles from "./editor.module.css";

class BlockOption extends MenuOption {
  constructor(public block: typeof blocks[number]) { super(block.id); }
}
const allOptions = blocks.map((block) => new BlockOption(block));
export function SlashMenu({ onImage }: { onImage: () => void }) {
  const [editor] = useLexicalComposerContext();
  const [query, setQuery] = useState<string | null>(null);
  const match = useBasicTypeaheadTriggerMatch("/", { minLength: 0, maxLength: 40 });
  const options = useMemo(() => allOptions.filter(({ block }) =>
    `${block.label} ${block.description}`.toLowerCase().includes((query || "").toLowerCase())), [query]);
  return <LexicalTypeaheadMenuPlugin options={options} onQueryChange={setQuery}
    triggerFn={(text, currentEditor) => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection) || $isCodeNode(selection.anchor.getNode().getParent())) return null;
      return match(text, currentEditor);
    }}
    anchorClassName={styles.slashAnchor}
    onSelectOption={(option, node, close) => {
      editor.update(() => {
        node?.remove();
        if (option.block.id === "image") onImage(); else $applyBlock(editor, option.block.id);
      });
      close();
    }}
    menuRenderFn={(anchor, { selectedIndex, selectOptionAndCleanUp, setHighlightedIndex }) => anchor.current ? createPortal(
      <CommandList label="Insert a block">
        {options.length ? options.map((option, index) => {
          const Icon = option.block.icon;
          return <CommandItem key={option.key} id={`typeahead-item-${index}`} ref={option.setRefElement}
            role="option" aria-selected={selectedIndex === index} icon={<Icon />} description={option.block.description}
            onMouseEnter={() => setHighlightedIndex(index)} onMouseDown={(event) => event.preventDefault()}
            onClick={() => selectOptionAndCleanUp(option)}>{option.block.label}</CommandItem>;
        }) : <CommandEmpty>No matching blocks</CommandEmpty>}
      </CommandList>, anchor.current) : null} />;
}
