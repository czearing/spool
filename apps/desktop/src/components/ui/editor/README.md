# Editor

Import `Editor` and `EditorHandle` from `src/components/ui/editor`.
Storybook: **Components / Editor**. The board intentionally stays unchanged.

```tsx
const editor = useRef<EditorHandle>(null);
<Editor ref={editor} label="Description" initialMarkdown="## Next steps" />
// On explicit save:
const document = editor.current?.getState();
const markdown = editor.current?.getMarkdown();
```

## API

| Prop | Behavior |
| --- | --- |
| `label` | Required accessible name of the writing surface |
| `id`, `required` | Optional field association and required-state announcement; the owning form validates serialized content |
| `initialMarkdown` | Initial content only, not a controlled value |
| `initialState` | Serialized Lexical JSON instead of initial Markdown |
| `onChange(state)` | Immediate immutable EditorState notification for content changes; no automatic serialization |
| `onMarkdownChange(markdown)` | Optional observer, debounced 300ms; pending notification is cancelled on unmount |
| `readOnly` | Disables editing and removes editing controls and drag handles |
| `placeholder`, `className` | Presentation overrides |
| `presentation="document"` | Contextual formatting and an on-demand Editing tools popover instead of the persistent toolbar/hint |
| `onError(error)` | Optional error observer; errors are also logged and visibly announced |

The ref provides `focus()`, `getState()`, `getMarkdown(optionalEditorState)`, and `setMarkdown(value)`.
`setMarkdown` deliberately replaces the document and clears undo history. To switch JSON documents,
mount with a different React `key`. Changing initial props never resets in-progress writing.
Use the ref on explicit save, or store `onChange`'s immutable state for autosave.
Do not rely on the delayed Markdown observer to flush during unmount.

## Writing and blocks

- Headings 1-6, paragraphs, quotes, nested ordered/bulleted lists, and interactive checklists.
- Bold, italic, underline, strikethrough, inline code, and highlighting.
- Markdown shortcuts, automatic URL/email links, and structured plain-Markdown paste.
- Slash-command picker; inline selection toolbar; block conversion, duplication, deletion and movement.
- Fenced code with language selection and lazily loaded syntax highlighting.
- Unlabelled code stays plain text; Markdown imports normalize Windows line endings before highlighting.
- Editable tables with Tab navigation and row/column insertion/deletion.
- URL images with descriptions, lazy loading, and explicit unavailable-image states.
- Callouts, collapsible toggles, dividers, undo and redo.

Hover or tap a block to reveal its grip. Drag it above/below another block.
Top-level paragraphs, headings, lists, code, callouts, toggles, images and tables move as units.
Text selection remains native; dragging is restricted to the grip. The drop line marks insertion.
Keyboard: focus the grip, Space to pick up, Up/Down to choose a position,
Space/Enter to drop, Escape to cancel. Alt+Up/Down moves one position without pickup.
Moves update Lexical's document model, preserve rich content, export in the new order, and are undoable.
Initial and reloaded documents seed history so the first grip move or checkbox click can also be undone.
The writing canvas intentionally has no focus rectangle; buttons retain visible keyboard focus.

## Interchange and boundaries

Persist Lexical JSON for exact document structure and toggle open/closed state.
Markdown supports the standard writing features above, plus pipe tables and checklists.
Extensions: `==highlight==`, `<u>underline</u>`, and fenced `:::callout` / `:::toggle Title`
blocks closed with `:::`. Container fences can nest. Other Markdown renderers need matching extensions.
Simple tables intentionally exclude merged cells and preserve a Markdown header row.
Links accept http(s), mailto, tel, root-relative and fragment URLs; images accept http(s) and root-relative URLs.
No HTML execution, data URLs, local-file URLs, or unconfigured image uploads.

This is not full Notion parity: collaboration, comments, databases, mentions, rich embeds, equations,
file uploads and server persistence are not implemented.

## Performance and composition

Lexical owns editable DOM and selection; typing does not mirror the document into React state.
Toolbar subscriptions update only when formatting/selection context changes. Each real block element
is registered with dnd-kit Sortable; its sorting strategy owns measurements and displacement.
No Markdown or JSON serialization runs per keystroke unless a consumer explicitly requests it.
Code highlighting loads only after a code block exists. Table, list, history, and Markdown behavior
come from Lexical; Radix handles menus, toolbar navigation, dialogs, tooltips and selection popovers.
Sortable's keyboard coordinates and dnd-kit sensors own pointer/touch/keyboard movement, cancellation and auto-scroll.
Shared `DragHandle`, `DropIndicator` and `ElementPreview` supply presentation; Floating UI owns anchored positioning.
The editor only adapts Lexical block keys to Sortable and commits one undoable model update per drop.
Shared Radix `Checkbox`, `Divider` and `Toolbar` are also usable independently in Storybook.
`Popover` and `CommandList` supply selection/slash-menu presentation; Lexical retains typeahead selection and keyboard ownership.
`CommandList` is headless presentation, also demonstrated with Radix Menu outside the editor; it does not add another keyboard engine.
Callout and Collapsible expose shared DOM factories for Lexical-owned content and React components for ordinary pages.
Editable disclosure titles remain native `summary` elements rather than editable text nested inside Radix trigger buttons.
The native disclosure adapter shares styles/content geometry with the standalone Radix Collapsible; native toggles synchronize into Lexical JSON.
Board and list insertion markers also use `DropIndicator`; inline, measured-rectangle and Floating UI anchors share its rendering.
Checklist adapters separate Lexical-managed text slots from React-owned checkbox hosts using `setDOMUnmanaged`.
This pinned Lexical API prevents its mutation observer from removing shared controls; no checkbox logic is reimplemented.
Menu checkbox items retain Radix menu semantics and share the checkbox indicator, not nested buttons.
CSS Modules reuse shared typography, spacing, semantic colors, focus and floating-surface tokens.
Editor-specific typography/geometry live in `src/app/editor-tokens.css`.
