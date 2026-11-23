export async function preloadAgentPage() {
  await Promise.all([
    import("../components/task-chat-content"),
    import("../components/agent-new-conversation"),
  ]);
}
