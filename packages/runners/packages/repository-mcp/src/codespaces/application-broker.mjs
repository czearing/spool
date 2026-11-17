import { randomUUID } from "node:crypto";

export const brokerApplicationClientId = "c0ab8ce9-e9a0-42e7-b064-33d422df41f1";
export const brokerApplicationResources = Object.freeze([
  "https://graph.microsoft.com", "https://arc.msn.com/v4",
  "6ab48b67-cd74-4ad4-81af-5932984589be",
  "https://m365.cloud.microsoft/v2",
  "https://substrate.office.com",
  "https://substrate.office.com/search",
  "https://substrate.office.com/sydney",
]);

export async function additionalApplicationCredentials(credentials, broker) {
  if (!broker) {
    if (process.platform !== "win32") throw new Error("Shared application broker sign-in requires the Windows host");
    const { NativeBrokerPlugin } = await import("@azure/msal-node-extensions");
    broker = new NativeBrokerPlugin();
  }
  const expected = credentials.account;
  const matches = account => account?.homeAccountId === expected.homeAccountId &&
    account.tenantId === expected.tenantId && account.localAccountId === expected.localAccountId;
  let accounts;
  const tokens = [];
  for (const resource of brokerApplicationResources) {
    let result;
    try {
      accounts ||= (await broker.getAllAccounts(brokerApplicationClientId, randomUUID())).filter(matches);
      if (accounts.length > 1) throw new Error("Ambiguous selected broker account");
      result = await broker.acquireTokenSilent({
        clientId: brokerApplicationClientId, scopes: [`${resource}/.default`],
        authority: `https://login.microsoftonline.com/${expected.tenantId}`,
        redirectUri: `ms-appx-web://Microsoft.AAD.BrokerPlugin/${brokerApplicationClientId}`,
        correlationId: randomUUID(), ...(accounts.length ? { accountId: accounts[0].nativeAccountId } : {}),
      });
    } catch {
      throw new Error("Shared BizChat sign-in is unavailable; renew the selected account's normal Windows sign-in");
    }
    if (!matches(result?.account) || result.idTokenClaims?.aud !== brokerApplicationClientId ||
        result.idTokenClaims.oid !== expected.localAccountId || result.idTokenClaims.tid !== expected.tenantId ||
        !result.accessToken || !result.idToken || result.tokenType !== "Bearer" ||
        !result.fromPlatformBroker || !Array.isArray(result.scopes) ||
        !result.scopes.includes(`${resource}/.default`) ||
        !Number.isFinite(result.expiresOn?.getTime()) || result.expiresOn.getTime() <= Date.now() + 120000)
      throw new Error("The shared BizChat client, selected account and credential expiry did not verify");
    tokens.push({ resource, accessToken: result.accessToken, idToken: result.idToken,
      scopes: result.scopes, expiresOn: result.expiresOn.toISOString() });
  }
  return { ...credentials, protocolVersion: 5, additionalClients: [{ clientId: brokerApplicationClientId, tokens }] };
}
