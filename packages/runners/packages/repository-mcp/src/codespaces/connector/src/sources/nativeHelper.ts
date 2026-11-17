import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ADO_RESOURCE, type AdoToken } from "./types.ts";

/**
 * Token source: the Codespaces native auth helper (`~/azure-auth-helper`,
 * ~125ms) — the fast path the 1JS sandbox broker uses before falling back to
 * the much slower `az` Python CLI (~1s+)
 * (packages/sandbox/src/sandbox.ts:425-476).
 *
 * Returns null — so the caller falls back to {@link ./hostAz.ts} — when the
 * helper is absent (e.g. a local dev machine, not a Codespace), disabled,
 * errors, or returns a token that is not for the ADO resource.
 */

function spawnAndCapture(
  cmd: string,
  args: string[],
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", () => resolve({ code: 127, output: "" }));
    child.on("close", (code) => resolve({ code, output }));
  });
}

// Decode the JSON payload (claims) of a JWT access token without verifying its
// signature (Azure DevOps verifies it server-side). Returns null if the token
// is not a well-formed JWT.
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length < 2) {
    return null;
  }
  try {
    return JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    ) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function getToken(): Promise<AdoToken | null> {
  if (process.env.CODESPACES_DISABLE_NATIVE_AUTH === "1") {
    return null;
  }

  const helperPath = join(homedir(), "azure-auth-helper");
  if (!existsSync(helperPath)) {
    return null;
  }

  let output: string;
  try {
    const result = await spawnAndCapture(helperPath, ["get-access-token"]);
    if (result.code !== 0) {
      return null;
    }
    output = result.output.trim();
  } catch {
    return null;
  }

  if (!output) {
    return null;
  }

  const payload = decodeJwtPayload(output);
  if (!payload) {
    return null;
  }

  // Ensure the token is actually for Azure DevOps before trusting it; otherwise
  // fall back to `az`, which requests the resource explicitly. `aud` may be a
  // single string or an array of audiences.
  const aud = payload["aud"];
  const isForAzureDevOps =
    aud === ADO_RESOURCE || (Array.isArray(aud) && aud.includes(ADO_RESOURCE));
  if (!isForAzureDevOps) {
    return null;
  }

  const exp = payload["exp"];
  if (typeof exp !== "number" || !Number.isFinite(exp)) {
    return null;
  }

  return { token: output, expiresAtMs: exp * 1000 };
}
