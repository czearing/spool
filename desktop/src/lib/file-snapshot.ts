import { stat } from "node:fs/promises";

export function hasCode(error: unknown, code: string) {
  return error instanceof Error && "code" in error && error.code === code;
}
export async function readFileSnapshot<E extends { file: string }, T>(
  list: () => Promise<E[]>, read: (entry: E) => Promise<T>, label: string,
): Promise<T[]> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await list();
    let items: T[];
    try {
      items = new Array<T>(before.length);
      let next = 0, failure: { error: unknown } | undefined;
      await Promise.all(Array.from({ length: Math.min(32, before.length) }, async () => {
        while (!failure && next < before.length) {
          const index = next++;
          try { items[index] = await read(before[index]); }
          catch (error) { failure ??= { error }; }
        }
      }));
      if (failure) throw failure.error;
    }
    catch (error) { if (hasCode(error, "ENOENT")) continue; throw error; }
    const after = await list();
    if (before.length !== after.length || before.some((entry, index) => entry.file !== after[index].file)) continue;
    return items;
  }
  throw new Error(`${label} kept changing during the read. Reload to obtain a consistent snapshot.`);
}

export function cachedFileReader<E extends { file: string }, T>(read: (entry: E) => Promise<T>) {
  const cache = new Map<string, { version: string; value: Promise<T> }>();
  return async (entry: E): Promise<T> => {
    const info = await stat(entry.file, { bigint: true });
    const version = `${info.ino}:${info.mtimeNs}:${info.ctimeNs}:${info.size}`;
    const saved = cache.get(entry.file);
    if (saved?.version === version) return saved.value;
    const pending = { version, value: read(entry) };
    cache.delete(entry.file);
    cache.set(entry.file, pending);
    const oldest = cache.keys().next().value;
    if (cache.size > 2000 && oldest !== undefined) cache.delete(oldest);
    try { return await pending.value; }
    catch (error) {
      if (cache.get(entry.file) === pending) cache.delete(entry.file);
      throw error;
    }
  };
}
