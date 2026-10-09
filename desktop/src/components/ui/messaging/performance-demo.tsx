import { memo, useRef, useState, type RefObject } from "react";
import { ChatInput } from "../chat-input";
import { MessageBubble } from "../message-bubble";
import { MessageHistory } from "../message-history";
import { MessageThread } from "../message-thread";
import { Button } from "../button";
import { Text } from "../text";
import { historyMessages, demoAnswer, type DemoMessage } from "./demo-data";
import { useDemoMessages } from "./use-demo-messages";
import styles from "./messaging-demo.module.css";

export function PerformanceDemo({ count = 1000 }: { count?: number }) {
  const [initial] = useState(() => historyMessages(count));
  const { messages, active, send, stop, generating } = useDemoMessages(initial, false, demoAnswer.repeat(40));
  const measurements = useRef({ draftNotifications: 0, historyRenders: 0 });
  const [report, setReport] = useState("");
  return <div className={styles.demo}>
    <header className={styles.header}>
      <Button onClick={() => { setReport(JSON.stringify(measurements.current)); }}>Inspect rendering</Button>
      <Text aria-label="Rendering measurements">{report}</Text>
    </header>
    <MessageThread><MeasuredHistory messages={messages} measurements={measurements} />
      {active && <MessageBubble {...active} />}
    </MessageThread>
    <div className={styles.composer}>
      <ChatInput label="Message" initialMarkdown={"Draft context. ".repeat(720)} onSubmit={send}
        onStop={generating ? stop : undefined}
        onDraftChange={() => { measurements.current.draftNotifications++; }} />
    </div>
  </div>;
}
const MeasuredHistory = memo(function MeasuredHistory({ messages, measurements }: {
  messages: DemoMessage[]; measurements: RefObject<{ historyRenders: number }>;
}) {
  measurements.current.historyRenders++;
  return <MessageHistory messages={messages} />;
});
