"use client";

import dynamic from "../platform/lazy";
import { useCallback, useRef, useState } from "react";
import { Check, CloudUpload } from "lucide-react";
import { AgentAvatar } from "./agent-avatar";
import type { AgentPrompt } from "../lib/agents";
import { usePromptSync } from "../hooks/use-prompt-sync";
import { Button } from "./ui/button";
import { Dialog, DialogClose } from "./ui/dialog";
import { Stack } from "./ui/stack";
import { Text } from "./ui/text";
import type { EditorHandle } from "./ui/editor";
import { NavigationLink } from "./navigation-link";
import styles from "./document-page.module.css";

const Editor = dynamic(() => import("./ui/editor").then((module) => module.Editor), {
  ssr: false, loading: () => <Text role="status" tone="secondary">Loading editor...</Text>,
});
export function AgentPromptEditor({ project, document }: { project: string; document: AgentPrompt }) {
  const editor = useRef<EditorHandle>(null), [reloadOpen, setReloadOpen] = useState(false);
  const { sync, state, attach, reload, syncError } = usePromptSync(project, document);
  const attachEditor = useCallback((handle: EditorHandle | null) => { editor.current = handle; attach(handle); }, [attach]);
  const status = state.phase === "error" ? "Not saved" : state.phase === "saved" ? syncError ? "Sync unavailable" : "All changes saved" : "Saving...";
  const StatusIcon = state.phase === "saved" ? Check : CloudUpload;
  return <Stack asChild gap={0}><main className={styles.page}>
    <Stack asChild direction="row" align="center" justify="space-between" gap={2} wrap><header className={styles.topbar}>
      <Stack asChild direction="row" align="center" gap={2}><Text asChild className={styles.breadcrumb} tone="secondary"><h1><AgentAvatar agent={document.id} />Agents<span aria-hidden="true">/</span>
        <NavigationLink href={`/${project}/agents/${encodeURIComponent(document.id)}`}>{document.id}</NavigationLink>
        <span aria-hidden="true">/</span><span>Prompt</span></h1></Text></Stack>
      <Stack asChild direction="row" align="center" gap={2}><Text role="status" aria-label="Prompt save status" variant="meta" tone="secondary" className={styles.status}>
        <StatusIcon aria-hidden="true" />{status}
      </Text></Stack>
    </header></Stack>
    <div className={styles.scroll}><div className={styles.document}>
      {state.error && <Stack gap={2} className={styles.error}>
        <Text role="alert">{state.error}</Text><Stack direction="row" gap={2}>
          {!state.conflict && <Button onClick={() => void sync.retry()}>Retry</Button>}
          <Button onClick={() => setReloadOpen(true)}>Reload latest</Button>
        </Stack>
      </Stack>}
      {syncError && !state.error && <Text role="alert" className={styles.error}>Live sync unavailable: {syncError}</Text>}
      <Editor ref={attachEditor} label={`${document.id} prompt`} initialMarkdown={document.prompt} presentation="document"
        onChange={(snapshot) => {
          const handle = editor.current;
          if (handle) sync.changed(() => handle.getMarkdown(snapshot));
        }} onError={(error) => sync.fail(error)} />
    </div></div>
    <Dialog open={reloadOpen} onOpenChange={setReloadOpen} title="Reload the latest prompt?"
      description="This replaces your current draft with the version on disk."
      footer={<><DialogClose asChild><Button>Keep editing</Button></DialogClose>
        <Button variant="primary" onClick={async () => { await reload(); setReloadOpen(false); }}>Reload latest</Button></>} />
  </main></Stack>;
}