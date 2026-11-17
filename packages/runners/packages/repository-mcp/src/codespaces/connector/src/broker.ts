import { createServer, type Server } from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import type { AdoToken, TokenSource } from "./sources/types.ts";

const DEFAULT_FRESH_WINDOW_MS = 5 * 60 * 1000;

export interface BrokerOptions {
  /**
   * Where to listen: a Unix-domain socket path, or `{ port }` to listen on TCP
   * loopback. Windows cannot bind an AF_UNIX socket for `ssh -R` forwarding, so
   * the CLI uses a loopback port there and forwards the remote Unix socket to
   * it (`ssh -R /remote.sock:127.0.0.1:<port>`).
   */
  socketPath: string | { port: number };
  /** Where tokens come from (mock / host-az / oidc). */
  source: TokenSource;
  /**
   * Refresh-before-expiry window. A cached token is considered stale once it is
   * within this many ms of expiry, so long-running callers never start with a
   * nearly-expired token. Defaults to 5 minutes (sandbox parity).
   */
  freshWindowMs?: number;
  /**
   * When true (default) the listening socket does not keep the host process
   * alive on its own; the embedding process (e.g. `ado-auth-connect`, which
   * waits on the ssh child) keeps the event loop running.
   */
  unref?: boolean;
}

/**
 * Start the ADO token broker on a Unix-domain socket. Returns a stop function.
 *
 * Faithful port of the 1JS sandbox token broker
 * (packages/sandbox/src/sandbox.ts:402-513): per-connection it returns a fresh
 * token followed by a newline, or `ERROR <message>\n`. Caches the token with a
 * freshness window and de-dupes concurrent mints with a single in-flight promise.
 */
export function startBroker(options: BrokerOptions): () => void {
  const freshWindowMs = options.freshWindowMs ?? DEFAULT_FRESH_WINDOW_MS;

  let cached: AdoToken | null = null;
  let inFlight: Promise<AdoToken> | null = null;

  const isFresh = (token: AdoToken): boolean =>
    token.expiresAtMs - Date.now() > freshWindowMs;

  const getCachedToken = async (): Promise<AdoToken> => {
    if (cached && isFresh(cached)) {
      return cached;
    }
    if (inFlight) {
      return inFlight;
    }
    inFlight = (async () => {
      const token = await options.source();
      if (!token?.token || !Number.isFinite(token.expiresAtMs)) {
        throw new Error("token source returned an invalid token");
      }
      cached = token;
      return cached;
    })();
    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  };

  const listenOnPort = typeof options.socketPath !== "string";

  if (!listenOnPort && existsSync(options.socketPath as string)) {
    unlinkSync(options.socketPath as string);
  }

  const server: Server = createServer((socket) => {
    // A short-lived SSH probe can disconnect while token minting is in flight.
    // Ignore that peer-local write error instead of crashing the broker owner.
    socket.on("error", () => {});
    getCachedToken()
      .then((token) => socket.end(`${token.token}\n`))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        socket.end(`ERROR ${message}\n`);
      });
  });

  if (listenOnPort) {
    const { port } = options.socketPath as { port: number };
    server.listen(port, "127.0.0.1");
  } else {
    server.listen(options.socketPath as string);
  }
  if (options.unref ?? true) {
    server.unref();
  }

  return () => {
    server.close();
    if (!listenOnPort && existsSync(options.socketPath as string)) {
      unlinkSync(options.socketPath as string);
    }
  };
}
