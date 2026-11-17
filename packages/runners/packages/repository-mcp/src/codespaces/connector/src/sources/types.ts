/**
 * A minted Azure DevOps access token together with its absolute expiry.
 */
export interface AdoToken {
  token: string;
  expiresAtMs: number;
}

/**
 * A token source mints a fresh {@link AdoToken}. The broker is agnostic to where
 * the token comes from; here it is the host's `az` login (see {@link ./hostAz.ts}),
 * reverse-forwarded into the codespace over `ssh -R` by `ado-auth-connect`.
 */
export type TokenSource = () => Promise<AdoToken>;

/** Azure DevOps resource id (constant across clouds). */
export const ADO_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798";

/**
 * The Azure CLI is a `.cmd` shim on Windows (`az.cmd`), and since the
 * CVE-2024-27980 hardening Node refuses to spawn `.cmd`/`.bat` files without a
 * shell — a bare `spawn("az", ...)` fails with `ENOENT` and naming the shim
 * explicitly fails with `EINVAL`. Spawning through the shell is therefore the
 * only option on Windows. Arguments passed to `az` here are fixed literals, so
 * shell quoting is not a concern.
 */
export const AZ_SPAWN_OPTIONS = { shell: process.platform === "win32" };
