import { spawn } from "node:child_process";
import { ADO_RESOURCE, AZ_SPAWN_OPTIONS, type AdoToken } from "./types.ts";

/**
 * Token source: mint an ADO token from the host's `az` login — the same call
 * the 1JS sandbox broker uses (packages/sandbox/src/sandbox.ts:420-469).
 */

interface AzTokenResponse {
  accessToken?: string;
  expires_on?: number;
  expiresOn?: string;
}

function spawnAndCapture(
  cmd: string,
  args: string[],
  opts: { shell?: boolean } = {},
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: opts.shell ?? false,
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", () => resolve({ code: 127, output: "" }));
    child.on("close", (code) => resolve({ code, output }));
  });
}

export async function getToken(): Promise<AdoToken> {
  const { code, output } = await spawnAndCapture(
    "az",
    ["account", "get-access-token", "--resource", ADO_RESOURCE, "-o", "json"],
    AZ_SPAWN_OPTIONS,
  );

  if (code !== 0 || !output.trim()) {
    throw new Error(
      "Failed to get ADO token from host Azure CLI. Run `az login` on the host.",
    );
  }

  const parsed = JSON.parse(output) as AzTokenResponse;
  if (!parsed.accessToken) {
    throw new Error("Host Azure CLI did not return an ADO token.");
  }

  const expiresAtMs = parsed.expires_on
    ? parsed.expires_on * 1000
    : Date.parse(parsed.expiresOn ?? "");
  if (!Number.isFinite(expiresAtMs)) {
    throw new Error(
      "Host Azure CLI returned an ADO token without a valid expiry.",
    );
  }

  return { token: parsed.accessToken, expiresAtMs };
}
