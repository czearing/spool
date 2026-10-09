export type JobCompletion = { key: string; id: string; title: string; agent?: string };
export function isJobCompletion(value: unknown): value is JobCompletion {
  return !!value && typeof value === "object" && "key" in value && typeof value.key === "string" &&
    "id" in value && typeof value.id === "string" && "title" in value && typeof value.title === "string" &&
    (!("agent" in value) || typeof value.agent === "string");
}
export function createCompletionTracker() {
  let seen: Set<string> | undefined;
  return (items: readonly JobCompletion[]) => {
    const fresh = seen ? items.filter(({ key }) => !seen!.has(key)) : [];
    seen ??= new Set();
    for (const item of items) seen.add(item.key);
    return fresh;
  };
}
