import { useState } from "react";
import { ChatInput } from "../chat-input";
import { MessageBubble } from "../message-bubble";
import { MessageHistory } from "../message-history";
import { MessageThread } from "../message-thread";
import { Button } from "../button";
import { Text } from "../text";
import { Stack } from "../stack";
import { Grid } from "../grid";
import { initialMessages, type DemoMessage } from "./demo-data";
import { useDemoMessages } from "./use-demo-messages";
import styles from "./messaging-demo.module.css";

export function MessagingDemo({ initial = initialMessages, failFirst = false, initialDraft = "", switchable = false }: {
  initial?: DemoMessage[]; failFirst?: boolean; initialDraft?: string; switchable?: boolean;
}) {
  const [conversation, setConversation] = useState(0);
  return <Grid gap={0} className={styles.demo}>
    <Stack asChild direction="row" align="center" gap={3}><header className={styles.header}><Text variant="heading">Messages</Text><Text variant="meta" tone="muted">Local preview</Text>
      {switchable && <Button onClick={() => setConversation((value) => value + 1)}>New conversation</Button>}
    </header></Stack>
    <Conversation key={conversation} initial={initial} failFirst={failFirst} initialDraft={initialDraft} />
  </Grid>;
}
function Conversation({ initial, failFirst, initialDraft }: { initial: DemoMessage[]; failFirst: boolean; initialDraft: string }) {
  const { messages, active, generating, send, stop, announcement } = useDemoMessages(initial, failFirst);
  return <>
    <MessageThread empty={!messages.length && !active}>
      <MessageHistory messages={messages} />{active && <MessageBubble key={active.id} {...active} />}
    </MessageThread>
    <Grid gap={2} className={styles.composer}>
      <span className={styles.announcement} role="status">{announcement}</span>
      <ChatInput label="Message" initialMarkdown={initialDraft} onSubmit={send} onStop={generating ? stop : undefined} />
    </Grid>
  </>;
}
