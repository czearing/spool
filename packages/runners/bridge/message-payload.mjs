import path from "node:path";
import { digest, publishOnce } from "./spool-files.mjs";

export const messageByteLimit = 65536;

export function continuationMessage(store, prompt) {
  if (typeof prompt !== "string" || !prompt.trim()) throw new Error("Continuation instructions must be nonempty text");
  if (Buffer.byteLength(prompt) <= messageByteLimit) return prompt;
  const sha256 = digest(prompt);
  const file = path.join(store.records, "message-prompts", `${sha256}.json`);
  const saved = publishOnce(file, { version: 1, sha256, prompt });
  if (saved.version !== 1 || saved.sha256 !== sha256 || saved.prompt !== prompt) {
    throw new Error("Saved continuation instructions do not match their content hash");
  }
  return [
    "# Task continuation",
    "Your complete new instructions are stored in a local JSON file because they exceed the inline message limit.",
    `Read the entire "prompt" string from ${file} before taking any action.`,
    `Instructions SHA-256: ${sha256}`,
    "Follow those instructions for this same work item and session, not the original assignment or an earlier completion summary.",
    "Do not truncate or skip findings. If the file cannot be read in full, report the failure and stop.",
  ].join("\n\n");
}
