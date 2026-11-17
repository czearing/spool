type Task = { id: string; agent: string; prompt: string };
type StoredTask<T> = T & { status: string; file: string };
export const queueStates: readonly string[];
export function safeId(value: unknown): string;
export function readJson(file: string, absent?: unknown): unknown;
export function readTaskRecord<T extends Task = Task>(file: string, state: string): StoredTask<T> | null;
export function readQueuedTask<T extends Task = Task>(queues: string, id: string): StoredTask<T> | null;
export function readQueuedTasks<T extends Task = Task>(queues: string): StoredTask<T>[];
