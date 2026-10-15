import { appFetch } from "../platform/request";
import { isConversation } from "./conversation-history";
import { ConversationError } from "./task-conversation";

export async function readConversationPage(url: string, signal?: AbortSignal) {
  const deadline = AbortSignal.timeout(15000);
  try {
    const response = await appFetch(url, {
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline, cache: "no-store",
    });
    const value: unknown = await response.json();
    if (!response.ok) {
      const error = value && typeof value === "object" && "error" in value ? value.error : undefined;
      throw new ConversationError(typeof error === "string" ? error : "Conversation unavailable.", response.status);
    }
    if (!isConversation(value) || !value.raw) throw new Error("Invalid conversation history response.");
    return value;
  } catch (error) {
    if (deadline.aborted && !signal?.aborted) {
      throw new Error("Conversation loading timed out. Your messages are saved. Retry to load the conversation.");
    }
    throw error;
  }
}
