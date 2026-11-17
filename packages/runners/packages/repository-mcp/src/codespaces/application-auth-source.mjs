import path from "node:path";
import { createRequire } from "node:module";
import { Console } from "node:console";

export const applicationClientId = "4765445b-32c6-49b0-83e6-1d93765276ca";
const legacyApplicationResources = Object.freeze([
  "https://graph.microsoft.com",
  "https://substrate.office.com",
  "https://designerappservice.officeapps.live.com",
]);
const browserApplicationResources = Object.freeze([
  ...legacyApplicationResources,
  "https://api.loop.cloud.microsoft",
  "https://microsoft.sharepoint-df.com",
  "https://pushchannel.1drv.ms",
  "https://clients.config.office.net",
]);
export const applicationResources = Object.freeze([
  ...browserApplicationResources,
  "https://substrate.office.com/sydney",
  "6ab48b67-cd74-4ad4-81af-5932984589be",
]);
export const completeApplicationResources = Object.freeze([
  ...applicationResources, "https://arc.msn.com/v4",
]);
export const fullApplicationResources = Object.freeze([
  ...completeApplicationResources, "https://augloop.office.com/v2",
]);

export async function applicationCredentials(protocol = 1) {
  const root = "/workspaces/1JS/midgard/packages/copilot-dev-auth-proxy";
  const requireStock = createRequire(path.join(root, "package.json"));
  const { build } = requireStock("esbuild");
  process.env.MSAL_CLIENT_ID = applicationClientId;
  process.env.MSAL_TENANT_ID = "72f988bf-86f1-41af-91ab-2d7cd011db47";
  process.env.DEV_AUTH_CACHE_ROOT = "/home/vscode/.ffx/copilot-dev-auth-proxy";
  process.env.DEV_AUTH_PROXY_DEBUG = "0";
  const bundled = await build({
    stdin: { contents: [
      `export * from ${JSON.stringify(path.join(root, "src/getDevMsalClient.ts"))};`,
      `export { extractIdentityFromMsalAccount, DEFAULT_DEV_AUTH_SCOPE } from ${JSON.stringify(path.join(root, "src/utils.ts"))};`,
    ].join("\n"), resolveDir: root, loader: "ts" },
    bundle: true, platform: "node", format: "cjs", target: "node22",
    conditions: ["source"], external: ["@azure/*"], write: false, logLevel: "silent",
  });
  const module = { exports: {} };
  new Function("require", "module", "exports", bundled.outputFiles[0].text)(requireStock, module, module.exports);
  const provider = module.exports;
  const account = await provider.getCachedMsalAccount("pca");
  if (!account) throw new Error("The shared application account requires normal interactive sign-in");
  const client = await provider.getDevMsalClient("pca");
  const tokens = [];
  for (const [resource, scope] of [
    ["https://m365.cloud.microsoft", protocol >= 2
      ? "https://m365.cloud.microsoft/v2/.default" : provider.DEFAULT_DEV_AUTH_SCOPE],
    ...(protocol >= 5 ? fullApplicationResources : protocol >= 4 ? completeApplicationResources :
      protocol >= 3 ? applicationResources : protocol >= 2 ? browserApplicationResources : legacyApplicationResources)
      .map(resource => [resource, `${resource}${protocol >= 4 &&
        resource === "https://designerappservice.officeapps.live.com" ? "/" : ""}/.default`]),
  ]) {
    const result = await client.acquireTokenSilent({ account, scopes: [scope], forceRefresh: true });
    if (!result?.accessToken || !result.idToken || !result.expiresOn ||
        result.expiresOn.getTime() <= Date.now() + 120000 ||
        result.account?.homeAccountId !== account.homeAccountId || result.account.tenantId !== account.tenantId)
      throw new Error("Shared application credentials did not verify the selected account and expiry");
    tokens.push({ resource, accessToken: result.accessToken, idToken: result.idToken,
      scopes: result.scopes, expiresOn: result.expiresOn.toISOString() });
  }
  const selected = await provider.getCachedMsalAccount("pca");
  const identity = provider.extractIdentityFromMsalAccount(account);
  if (!identity || selected?.homeAccountId !== account.homeAccountId || selected.tenantId !== account.tenantId)
    throw new Error("The selected shared application account changed during authentication");
  return { account: { ...account, tenantProfiles: [...(account.tenantProfiles || [])] }, identity, tokens };
}

const protocol = [
  ["--application-credentials", 1], ["--application-credentials-v2", 2],
  ["--application-credentials-v3", 3], ["--application-credentials-v4", 4],
  ["--application-credentials-v5", 5],
].find(([flag]) => process.argv.includes(flag))?.[1];
if (protocol) {
  globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });
  try { process.stdout.write(JSON.stringify(await applicationCredentials(protocol))); }
  catch {
    process.stderr.write("Shared application sign-in is unavailable; renew the existing stock dev-auth account\n");
    process.exitCode = 1;
  }
}
