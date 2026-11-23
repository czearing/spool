import { appFetch } from "./request";

class ReadError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export const readQueryRecovery = {
  networkMode: "always" as const,
  retry: (failures: number, error: Error) => failures < 2 && error.name !== "AbortError" &&
    !(error instanceof SyntaxError) &&
    (!(error instanceof ReadError) || error.status >= 500 || [408, 429].includes(error.status)),
  retryDelay: (attempt: number) => Math.min(500 * 2 ** attempt, 3000),
};

export async function readJson<T>(url: string, signal: AbortSignal,
  fallback = "Could not load saved data."): Promise<T> {
  const deadline = AbortSignal.timeout(15000);
  try {
    const response = await appFetch(url, { signal: AbortSignal.any([signal, deadline]), cache: "no-store" });
    const value = await response.json().catch(error => {
      if (!response.ok) throw new ReadError(fallback, response.status);
      throw error;
    });
    if (!response.ok) throw new ReadError(typeof value?.error === "string" ? value.error : fallback, response.status);
    signal.throwIfAborted();
    return value;
  } catch (error) {
    signal.throwIfAborted();
    if (deadline.aborted)
      throw new DOMException("Loading saved data timed out. Your saved data has not been changed.", "TimeoutError");
    throw error;
  }
}
