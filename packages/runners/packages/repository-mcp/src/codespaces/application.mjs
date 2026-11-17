import fs from "node:fs";
import { readCodespaceConfig, shellQuote } from "./config.mjs";
import { CodespaceTransport } from "./transport.mjs";
import { applicationResources, fullApplicationResources } from "./application-auth-source.mjs";

export function applicationAuthConfig(config, registered) {
  if (!config || Object.keys(config).length !== 1 || !registered.includes(config.ownerConfig))
    throw new Error("Application authentication requires an explicitly registered shared auth owner");
  return readCodespaceConfig(config.ownerConfig);
}

export async function acquireApplicationCredentials(target, owner, dependencies = {}) {
  if (!owner || owner.purpose !== "engineering" || target.githubAccount !== owner.githubAccount)
    throw new Error("Application authentication must use a registered owner on the same GitHub account");
  const transport = dependencies.transport || new CodespaceTransport(owner);
  await transport.environment();
  const details = JSON.parse((await transport.gh(["api", `user/codespaces/${owner.codespace}`])).stdout);
  if (details.repository?.full_name !== "office-fuel/1JSBridgeRepo")
    throw new Error("Application auth owner is not an approved 1JS Codespace");
  const source = fs.readFileSync(new URL("./application-auth-source.mjs", import.meta.url), "utf8");
  let credentials;
  try {
    const result = await transport.ssh(`${shellQuote(owner.nativeProfile.nodeExecutable)} --input-type=module ` +
      `-e ${shellQuote(source)} -- --application-credentials-v${dependencies.complete ? 5 : 3}`, 120);
    credentials = JSON.parse(result.stdout);
  } catch {
    throw new Error("Shared application sign-in is unavailable; renew the existing stock dev-auth account");
  }
  const resources = dependencies.complete ? ["https://m365.cloud.microsoft", ...fullApplicationResources]
    : ["https://m365.cloud.microsoft", ...applicationResources];
  if (!credentials.account?.homeAccountId || !credentials.identity ||
      credentials.identity.objectId !== credentials.account.localAccountId ||
      credentials.identity.tenantId !== credentials.account.tenantId ||
      !Array.isArray(credentials.tokens) || credentials.tokens.length !== resources.length ||
      new Set(credentials.tokens.map(token => token.resource)).size !== resources.length ||
      credentials.tokens.some(token => !resources.includes(token.resource) || !token.accessToken || !token.idToken ||
        !Array.isArray(token.scopes) || !token.scopes.length || !Number.isFinite(Date.parse(token.expiresOn)) ||
        Date.parse(token.expiresOn) <= Date.now() + 120000))
    throw new Error("The shared application account and credential expiry did not verify");
  return credentials;
}
