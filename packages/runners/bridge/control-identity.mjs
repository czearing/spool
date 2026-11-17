import { createHash } from "node:crypto";

export const digest = value => createHash("sha256").update(value).digest("hex");

export function commandIdentity(key) {
  return digest(key).slice(0, 32)
    .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
}

export function recoveryCommandId(task, message, startup = false) {
  return commandIdentity(message
    ? `native-operator-resume:${task.id}:${message.id}${startup ? `:${task.updated_at}` : ""}`
    : startup ? `native-chat-start:${task.id}:${task.updated_at}`
      : `native-empty-restore:${task.id}:${task.session_id}`);
}
