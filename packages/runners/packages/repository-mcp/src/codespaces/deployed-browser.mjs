import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { preserveApplicationSignInState, privateDirectory, privateJson } from "./application-browser.mjs";

export const previewOrigin = "https://m365.cloud.dev.microsoft";

export function deployedPreview(prId, sourceCommit) {
  if (!Number.isSafeInteger(prId) || prId < 1 || !/^[a-f0-9]{40}$/i.test(sourceCommit || ""))
    throw new Error("Deployed authentication requires an exact PR and source revision");
  return { prId, sourceCommit: sourceCommit.toLowerCase(), origin: previewOrigin,
    url: `${previewOrigin}/chat?pr=${prId}&enablePRWatermark=1` };
}

export function deployedPreviewDirectory(directory, target) {
  if (!/^\/workspaces\/\.spool-[a-z0-9-]+-tools\/deployed-application$/.test(directory || ""))
    throw new Error("Deployed browser state must use the assigned private runtime");
  const verified = deployedPreview(target.prId, target.sourceCommit);
  return `${directory}/previews/${verified.prId}-${verified.sourceCommit}`;
}

export function verifiedPreviewState(state, target, account, watermark, now = Date.now()) {
  const cookies = state.cookies?.filter(cookie => cookie.domain.replace(/^\./, "") === new URL(previewOrigin).hostname) || [];
  const parse = name => {
    try { return JSON.parse(decodeURIComponent(cookies.find(cookie => cookie.name === name)?.value || "null")); }
    catch { throw new Error("The deployed session's authentication cookies are invalid"); }
  };
  const identity = parse("dev-auth-UserInfo"), token = parse("dev-auth-AccessToken");
  if (!account || identity?.userPrincipalName?.toLowerCase() !== account.toLowerCase() ||
      !identity.objectId || !identity.tenantId || !token?.accessToken ||
      !Number.isFinite(token.expirationTime) || token.expirationTime <= now + 120000)
    throw new Error("The deployed session requires the selected account's normal sign-in");
  const expected = new RegExp(`\\bPR\\s+${target.prId}\\s+\\(${target.sourceCommit.slice(0, 7)}\\)`);
  if (!expected.test(watermark || "")) throw new Error("The deployed PR watermark does not match the requested revision");
  const origins = state.origins?.filter(origin => origin.origin === previewOrigin) || [];
  if (!origins.length) throw new Error("The deployed origin's browser authentication cache is missing");
  return { state: { cookies: preserveApplicationSignInState(cookies, identity, now), origins }, authentication: { version: 1, ready: true,
    origin: previewOrigin, prId: target.prId, sourceCommit: target.sourceCommit,
    accountVerified: true, accountHash: createHash("sha256").update(account.toLowerCase()).digest("hex"),
    expiresOn: new Date(token.expirationTime).toISOString(),
    verifiedAt: new Date(now).toISOString() } };
}

export async function capturePreviewSession(context, page, target, account) {
  const url = new URL(page.url());
  if (url.origin !== previewOrigin || !/^\/(?:home|chat|library|search)(?:\/|$)/.test(url.pathname))
    throw new Error("The deployed browser did not reach an authenticated application route");
  const watermark = await page.locator("body").evaluate(body => getComputedStyle(body, "::before").content);
  return { ...verifiedPreviewState(await context.storageState({ indexedDB: true }), target, account, watermark), watermark };
}

export async function refreshManagedPreview(config, target) {
  const { prId, sourceCommit } = deployedPreview(target.prId, target.sourceCommit);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(config.socket);
    let output = "";
    socket.setTimeout(300000, () => socket.destroy(new Error("Managed preview sign-in refresh timed out")));
    socket.once("connect", () => socket.write(JSON.stringify({
      capability: config.capability, action: "browser-refresh", prId, sourceCommit,
    }) + "\n"));
    socket.on("data", chunk => {
      output += chunk;
      if (output.length > 4096) socket.destroy(new Error("Invalid managed preview refresh response"));
    });
    socket.once("error", reject);
    socket.once("end", () => {
      try {
        if (JSON.parse(output).refreshed !== true) throw new Error("Managed preview sign-in refresh failed");
        resolve();
      } catch (error) { reject(error); }
    });
    socket.once("close", () => reject(new Error("Managed preview sign-in bridge closed before renewal completed")));
  });
}

export async function openDeployedApplicationBrowser(directory, { prId, sourceCommit,
  viewport = { width: 1440, height: 1000 } } = {}) {
  const target = deployedPreview(prId, sourceCommit);
  const preview = deployedPreviewDirectory(directory, target);
  privateDirectory(directory);
  privateDirectory(path.dirname(preview));
  privateDirectory(preview);
  const requestRefresh = () => privateJson(path.join(preview, "refresh-request.json"),
    { version: 1, prId, sourceCommit: target.sourceCommit });
  const read = (root, name) => {
    const file = path.join(root, name), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077))
      throw new Error("Deployed browser state is not private and owned");
    return JSON.parse(fs.readFileSync(file, "utf8"));
  };
  let ready, state, stateDirectory = preview;
  try {
    if (!fs.existsSync(path.join(preview, "authentication.json"))) stateDirectory = directory;
    ready = read(stateDirectory, "authentication.json");
    state = read(stateDirectory, "browser-state.json");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const current = () => ready && state && Array.isArray(state.cookies) && Array.isArray(state.origins) &&
    ready.version === 1 && ready.ready && ready.accountVerified && ready.origin === previewOrigin &&
    ready.prId === prId && ready.sourceCommit === target.sourceCommit &&
    Number.isFinite(Date.parse(ready.expiresOn)) && Date.parse(ready.expiresOn) > Date.now() + 120000;
  if (!current())
  {
    requestRefresh();
    const { renewVmPreview } = await import("./deployed-vm.mjs");
    let renewed = await renewVmPreview(directory, target);
    const authFile = process.env.SPOOL_REVIEW_AZURE_AUTH_FILE;
    if (!renewed && authFile?.startsWith("/workspaces/")) {
      await refreshManagedPreview(read(path.dirname(authFile), path.basename(authFile)), target);
      renewed = { authentication: read(preview, "authentication.json"), state: read(preview, "browser-state.json") };
    }
    if (!renewed)
      throw new Error("Managed deployed sign-in has no available renewal bridge");
    ready = renewed.authentication;
    state = renewed.state;
    if (!current()) throw new Error("Managed preview renewal did not produce fresh state for the requested revision");
  }
  const identity = JSON.parse(decodeURIComponent(state.cookies.find(cookie => cookie.name === "dev-auth-UserInfo")?.value || "null"));
  state = { ...state, cookies: preserveApplicationSignInState(state.cookies, identity) };
  const { chromium } = createRequire("/workspaces/1JS/midgard/packages/m365-copilot-app/package.json")("playwright");
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  try {
    const context = await browser.newContext({ viewport, storageState: state });
    const page = await context.newPage();
    return { browser, context, page, target, async close() {
      try {
        const renewed = await capturePreviewSession(context, page, target, identity?.userPrincipalName);
        privateJson(path.join(preview, "browser-state.json"), renewed.state);
        privateJson(path.join(preview, "authentication.json"), renewed.authentication);
      } catch (error) {
        if (/normal sign-in|authenticated application route|authentication cookies/.test(error.message)) requestRefresh();
        throw error;
      } finally { await browser.close(); }
    } };
  } catch (error) { await browser.close(); throw error; }
}
