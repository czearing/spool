import { useState, type FormEvent } from "react";
import { $getSelection, $isRangeSelection, $createTextNode } from "lexical";
import { $createLinkNode, TOGGLE_LINK_COMMAND } from "@lexical/link";
import type { LexicalEditor } from "lexical";
import { Dialog } from "../dialog";
import { Input } from "../input";
import { Button } from "../button";
import { Stack } from "../stack";
import { $createImageNode } from "./image-node";
import { safeEditorUrl } from "./urls";

export function EditorDialog({ kind, editor, run, onClose, initialUrl = "" }: {
  kind: "link" | "image"; editor: LexicalEditor; run: (action: () => void) => void; onClose: () => void; initialUrl?: string;
}) {
  const [url, setUrl] = useState(initialUrl), [label, setLabel] = useState(""), [error, setError] = useState("");
  const close = () => { onClose(); requestAnimationFrame(() => { run(() => {}); editor.focus(); }); };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = url.trim();
    if (!safeEditorUrl(value, kind === "image")) { setError(kind === "image" ? "Use an http(s) image URL or a root-relative path." : "Use an http(s), mailto, tel, root-relative, or anchor URL."); return; }
    run(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) throw new Error("Select a position in the document before inserting content.");
      if (kind === "image") selection.insertNodes([$createImageNode(value, label)]);
      else if (selection.isCollapsed() && !initialUrl) selection.insertNodes([$createLinkNode(value).append($createTextNode(label || value))]);
      else editor.dispatchCommand(TOGGLE_LINK_COMMAND, value);
    });
    close();
  };
  return <Dialog open onOpenChange={(open) => { if (!open) close(); }} title={kind === "image" ? "Insert image" : "Edit link"}
    description={kind === "image" ? "Use a hosted image. Uploads are not configured." : "Link the selected text, or insert a new link."}>
    <form onSubmit={submit}><Stack gap={4}>
      <Input label="URL" value={url} onChange={(event) => { setUrl(event.target.value); setError(""); }} required error={error || undefined} autoFocus />
      {(kind === "image" || !initialUrl) && <Input label={kind === "image" ? "Image description" : "Link text (optional)"}
        description={kind === "image" ? "Describe the image for readers using assistive technology." : undefined}
        required={kind === "image"} value={label} onChange={(event) => setLabel(event.target.value)} />}
      <Stack direction="row" justify="end" gap={2}>
        {kind === "link" && initialUrl && <Button onClick={() => { run(() => { editor.dispatchCommand(TOGGLE_LINK_COMMAND, null); }); close(); }}>Remove link</Button>}
        <Button onClick={close}>Cancel</Button><Button variant="primary" type="submit">{kind === "image" ? "Insert image" : "Save link"}</Button>
      </Stack>
    </Stack></form>
  </Dialog>;
}
