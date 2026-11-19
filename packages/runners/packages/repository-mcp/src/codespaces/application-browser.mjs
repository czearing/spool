import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import { X509Certificate } from "node:crypto";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = "/workspaces/1JS";
const origin = "https://localhost:3000";
const run = promisify(execFile);
const app = () => createRequire(`${root}/midgard/packages/m365-copilot-app/package.json`);
const auth = () => createRequire(`${root}/midgard/packages/hybrid-client-auth-shared/package.json`);
const dev = () => createRequire(`${root}/midgard/packages/dev-auth-react-msal-v4/package.json`);

export function preserveApplicationSignInState(cookies, identity, now = Date.now()) {
  if (identity.signinState !== undefined) return cookies;
  try {
    const token = JSON.parse(decodeURIComponent(cookies.find(cookie => cookie.name === "dev-auth-SydneyToken")?.value || "null"));
    const claims = JSON.parse(Buffer.from(token.accessToken.split(".")[1], "base64url").toString("utf8"));
    if (claims.aud !== "https://substrate.office.com/sydney" ||
        claims.iss !== `https://sts.windows.net/${identity.tenantId}/` ||
        claims.oid !== identity.objectId || claims.tid !== identity.tenantId ||
        ![claims.upn, claims.preferred_username, claims.unique_name].some(value =>
          typeof value === "string" && value.toLowerCase() === identity.userPrincipalName.toLowerCase()) ||
        !Number.isFinite(claims.exp) || claims.exp * 1000 <= now + 120000 ||
        !Number.isFinite(token.expirationTime) || token.expirationTime <= now + 120000 ||
        !Array.isArray(claims.signin_state) || !claims.signin_state.every(value => typeof value === "string"))
      return cookies;
    // The normal dev sign-in mapper omits this genuine claim from its identity cookie.
    return cookies.map(cookie => cookie.name === "dev-auth-UserInfo" ? { ...cookie,
      value: encodeURIComponent(JSON.stringify({ ...identity, signinState: claims.signin_state })),
    } : cookie);
  } catch { return cookies; }
}

export async function prepareApplicationBrowser(execute = run) {
  try { await execute("sh", ["-c", "command -v certutil"]); }
  catch (error) {
    if (![1, 127].includes(error.code)) throw error;
    await execute("sudo", ["-n", "apt-get", "update"]);
    await execute("sudo", ["-n", "apt-get", "install", "-y", "--no-install-recommends", "libnss3-tools"]);
    await execute("sh", ["-c", "command -v certutil"]);
  }
}

export function developmentCookies(credentials) {
  const office = credentials.tokens.find(token => token.resource === "https://m365.cloud.microsoft");
  if (!office) throw new Error("Real application server credentials are missing");
  const cookies = [
    ["dev-auth-UserInfo", credentials.identity],
    ["dev-auth-AccessToken", { accessToken: office.accessToken, expirationTime: Date.parse(office.expiresOn) }],
  ];
  for (const [resource, name] of [
    ["https://substrate.office.com/sydney", "dev-auth-SydneyToken"],
    ["6ab48b67-cd74-4ad4-81af-5932984589be", "dev-auth-CoworkerToken"],
  ]) {
    const token = credentials.tokens.find(token => token.resource === resource);
    if (token) cookies.push([name,
      { accessToken: token.accessToken, expirationTime: Date.parse(token.expiresOn) }]);
  }
  return cookies.map(([name, value]) => ({ name, value: encodeURIComponent(JSON.stringify(value)),
    url: origin, secure: true, sameSite: "Strict" }));
}

export function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory ||
      stat.uid !== process.getuid() || (stat.mode & 0o077))
    throw new Error("Application state must be a private, owned, non-redirected directory");
}

function privateStateFile(file) {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)))
    throw new Error("Application state file is not private and owned");
  return Boolean(stat);
}

export function privateJson(file, value) {
  privateStateFile(file);
  fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
}

export async function trustApplicationCertificate(directory) {
  const file = `${root}/midgard/packages/m365-copilot-app/dist/server/lib/cert.pem`;
  if (fs.realpathSync(file) !== file) throw new Error("Application certificate redirects");
  const pem = fs.readFileSync(file);
  const certificate = new X509Certificate(pem);
  if (!certificate.checkHost("localhost") || !certificate.verify(certificate.publicKey) ||
      Date.parse(certificate.validFrom) > Date.now() || Date.parse(certificate.validTo) <= Date.now())
    throw new Error("The stock application localhost certificate is invalid");
  const home = path.join(directory, "browser-home"), database = path.join(home, ".pki", "nssdb");
  privateDirectory(home);
  privateDirectory(path.dirname(database));
  privateDirectory(database);
  if (!fs.existsSync(path.join(database, "cert9.db")))
    await run("certutil", ["-N", "-d", `sql:${database}`, "--empty-password"]);
  await run("certutil", ["-A", "-d", `sql:${database}`, "-n", "spool-application-localhost",
    "-t", "C,,", "-i", file]);
  return { home, pem };
}

export async function waitForApplication(directory, timeoutMs = 900000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { pem } = await trustApplicationCertificate(directory);
      const status = await new Promise((resolve, reject) => {
        const request = https.get(`${origin}/spalanding`, { ca: pem, timeout: 5000 }, response => {
          response.resume();
          resolve(response.statusCode);
        });
        request.on("timeout", () => request.destroy(new Error("Application not ready")));
        request.on("error", reject);
      });
      if (status >= 200 && status < 500) return;
    } catch (error) {
      if (/redirects|invalid|private|owned/.test(error.message)) throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error("The application did not start; inspect its retained startup log and repair setup through repo_prepare");
}

async function applicationBrowser(directory) {
  privateDirectory(directory);
  const { home } = await trustApplicationCertificate(directory);
  const { chromium } = app()("playwright");
  return chromium.launch({ headless: true, chromiumSandbox: true, env: { ...process.env, HOME: home } });
}

export function sharedApplicationStorageState(ready, directory, sessionId) {
  if (ready && /^[a-f0-9-]{36}$/.test(sessionId || "") && ready.sessionId === sessionId &&
      ready.accountVerified === true && ready.graphStatus === 200 && ready.cacheHit === true &&
      ready.stateDirectory === directory && ready.storageState === `${directory}/browser-state.json` &&
      Date.parse(ready.expiresOn) > Date.now() + 120000)
    return ready.storageState;
}

export async function openApplicationBrowser(directory, viewport = { width: 1440, height: 1000 }) {
  if (!process.env.SPOOL_APPLICATION_STATE_DIRECTORY) {
    const { ensureVmApplication } = await import("./application-vm.mjs");
    await ensureVmApplication(directory);
  }
  const browser = await applicationBrowser(directory);
  try {
    let file = path.join(directory, "browser-state.json");
    if (process.env.SPOOL_APPLICATION_STATE_DIRECTORY &&
        (directory === process.env.SPOOL_APPLICATION_STATE_DIRECTORY || !privateStateFile(file))) {
      const shared = process.env.SPOOL_APPLICATION_STATE_DIRECTORY;
      file = undefined;
      if (!/^\/workspaces\/\.spool-[a-z0-9-]+-tools\/application-state$/.test(shared))
        throw new Error("Shared application state is outside its registered runtime");
      privateDirectory(shared);
      const receipt = path.join(shared, "authentication.json");
      if (privateStateFile(receipt)) {
        const ready = JSON.parse(fs.readFileSync(receipt, "utf8"));
        file = sharedApplicationStorageState(ready, shared, process.env.SPOOL_APPLICATION_STATE_SESSION);
      }
    }
    const context = await browser.newContext({ viewport,
      ...(file && privateStateFile(file) ? { storageState: file } : {}) });
    return { browser, context, page: await context.newPage() };
  } catch (error) { await browser.close(); throw error; }
}

export async function authenticateApplication(directory, credentials) {
  const bundled = await app()("esbuild").build({
    stdin: { contents: [
      `export * from ${JSON.stringify(dev().resolve("@azure/msal-browser-v4"))};`,
      `export { PublicClientApplication as ApplicationClient } from ${JSON.stringify(auth().resolve("@azure/msal-browser-1p"))};`,
    ].join("\n"), resolveDir: `${root}/midgard` },
    bundle: true, platform: "browser", format: "iife", globalName: "spoolApplicationMsal",
    write: false, logLevel: "silent",
  });
  const browser = await applicationBrowser(directory);
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    await context.addCookies(developmentCookies(credentials));
    const landing = await page.goto(`${origin}/spalanding`, { waitUntil: "domcontentloaded", timeout: 120000 });
    if (!landing?.ok() || new URL(page.url()).origin !== origin)
      throw new Error("The stock application landing page did not remain on its supported local origin");
    await page.addScriptTag({ content: bundled.outputFiles[0].text });
    const verified = await page.evaluate(async ({ account, tokens, additionalClients = [] }) => {
      account.tenantProfiles = new Map(account.tenantProfiles);
      const clients = [{ clientId: "4765445b-32c6-49b0-83e6-1d93765276ca", tokens }, ...additionalClients];
      let verified;
      for (const { clientId, tokens: clientTokens } of clients) {
        const config = { auth: { clientId,
          authority: `https://login.microsoftonline.com/${account.tenantId}`,
          redirectUri: `${location.origin}/spalanding` }, cache: { cacheLocation: "localStorage" } };
        const development = new spoolApplicationMsal.PublicClientApplication(config);
        await development.initialize();
        for (const token of clientTokens)
          await development.getTokenCache().loadExternalTokens(
            { account, scopes: token.scopes, authority: config.auth.authority },
            { access_token: token.accessToken, id_token: token.idToken, token_type: "Bearer",
              scope: token.scopes.join(" "), expires_in: Math.floor((Date.parse(token.expiresOn) - Date.now()) / 1000) },
            {});
        const application = new spoolApplicationMsal.ApplicationClient(config);
        await application.initialize();
        const current = application.getAllAccounts().find(value => value.homeAccountId === account.homeAccountId);
        if (!current) throw new Error("The application's MSAL client cannot read the signed-in account");
        application.setActiveAccount(current);
        for (const token of clientTokens) {
          const cached = await application.acquireTokenSilent({ scopes: token.scopes });
          if (!cached.fromCache) throw new Error("A real application resource was not retained in the browser cache");
        }
        const graph = clientTokens.find(token => token.resource === "https://graph.microsoft.com");
        const result = await application.acquireTokenSilent({ scopes: graph.scopes });
        const response = await fetch("https://graph.microsoft.com/v1.0/me?$select=id", {
          headers: { Authorization: `Bearer ${result.accessToken}` },
        });
        if (response.status !== 200 || (await response.json()).id !== account.localAccountId)
          throw new Error("Real browser resource authentication failed");
        verified = { graphStatus: response.status, accountVerified: true, cacheHit: result.fromCache === true };
      }
      return { ...verified, credentialClients: clients.map(client =>
        ({ clientId: client.clientId, resources: client.tokens.map(token => token.resource) })) };
    }, credentials);
    privateJson(path.join(directory, "browser-state.json"), await context.storageState());
    const library = await page.goto(`${origin}/library/all`, { waitUntil: "domcontentloaded", timeout: 180000 });
    if (!library?.ok() || new URL(page.url()).origin !== origin)
      throw new Error("The stock Library route did not serve on its supported local origin");
    return { ...verified, url: `${origin}/library/all`,
      credentialResources: credentials.tokens.map(token => token.resource),
      storageState: path.join(directory, "browser-state.json"),
      browserHelper: fileURLToPath(import.meta.url), stateDirectory: directory,
      expiresOn: new Date(Math.min(...[
        ...credentials.tokens, ...(credentials.additionalClients || []).flatMap(client => client.tokens),
      ].map(token => Date.parse(token.expiresOn)))).toISOString() };
  } finally { await browser.close(); }
}

if (process.argv.includes("--prepare-application-browser") || process.argv.includes("--authenticate-application")) {
  try {
    if (process.argv.includes("--prepare-application-browser")) {
      await prepareApplicationBrowser();
      process.stdout.write(JSON.stringify({ ready: true }));
    } else {
      const { directory, credentials } = JSON.parse(fs.readFileSync(0, "utf8"));
      await waitForApplication(directory);
      process.stdout.write(JSON.stringify(await authenticateApplication(directory, credentials)));
    }
  } catch (error) {
    process.stderr.write(`Application browser setup failed: ${error.message.split("\n")[0]}\n`);
    process.exitCode = 1;
  }
}
