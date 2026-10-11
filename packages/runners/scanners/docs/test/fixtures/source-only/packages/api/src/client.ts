/**
 * The api client surface.
 * @property retries how many times a call is retried
 */
export interface ClientOptions {
  /** The base url every call is made against. */
  baseUrl: string;
  timeoutMs: number;
  headers: Record<string, string>;
}

/**
 * Sends one request.
 * @param path the path to call
 * @param retryCount removed a while ago
 */
export function send(path: string): string {
  return path;
}
