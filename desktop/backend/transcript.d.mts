import type { ConversationEntry } from "../src/lib/task-conversation";

export const maxEntryText: number;
export function bounded(value: unknown): string;
export function appendEvent(entries: ConversationEntry[], event: unknown, fallbackTime: string): void;
export function appendEvents(previous: readonly ConversationEntry[], events: readonly unknown[], fallbackTime: string): ConversationEntry[];
