import type { ConversationStore, StoredTask } from "../src/lib/conversation-store";
import type { TaskConversation } from "../src/lib/task-conversation";
export function monitorConversation(store: ConversationStore, id: string, before?: number | null,
  individual?: boolean): (TaskConversation & { task: StoredTask }) | null;
