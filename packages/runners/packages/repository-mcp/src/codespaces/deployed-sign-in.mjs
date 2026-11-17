import fs from "node:fs";
import path from "node:path";
import { resolve4 } from "node:dns/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { capturePreviewSession, deployedPreview } from "./deployed-browser.mjs";
import { verifiedVmApplicationState } from "./application-vm.mjs";

export async function waitForDeployedSignIn(context, page, target, account, {
  capture = capturePreviewSession, pause = () => new Promise(resolve => setTimeout(resolve, 1000)),
  timeoutMs = 90000, interactive = false,
} = {}) {
  let selected = false, requested = false;
  let verificationFailure;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (/Azure Container App - Unavailable/i.test(await page.title?.() || ""))
      throw new Error("The deployed preview is unavailable; app sign-in cannot be verified");
    const url = new URL(page.url());
    if (url.origin === target.origin && /^\/(?:home|chat|library|search)(?:\/|$)/.test(url.pathname)) {
      try { return await capture(context, page, target, account); }
      catch (error) {
        if (error.name === "TimeoutError" || /Timeout \d+ms exceeded|Execution context was destroyed/.test(error.message)) {
          verificationFailure = error;
          await pause();
          continue;
        }
        if (!/normal sign-in|authentication cookies|watermark|authenticated application route|browser authentication cache/.test(error.message))
          throw error;
        verificationFailure = error;
      }
    }
    const popup = context.pages().find(candidate =>
      new URL(candidate.url()).origin === "https://login.microsoftonline.com");
    if (popup) {
      const challenge = await popup.locator('input[name="passwd"],input[name="accesspass"]').first().isVisible() ||
        await popup.locator("#idDiv_SAOTCAS_Description").isVisible();
      if (challenge && !interactive)
        throw new Error("Complete the selected account's normal Windows sign-in/MFA, then retry; no credential fallback was attempted");
      if (!challenge && !selected) {
        const tile = popup.getByText(account, { exact: true }), email = popup.locator('input[name="loginfmt"]');
        if (await tile.count() === 1 && await tile.isVisible()) { await tile.click(); selected = true; }
        else if (await email.isVisible()) {
          await email.fill(account);
          await popup.getByRole("button", { name: "Next", exact: true }).click();
          selected = true;
        }
      }
    } else if (url.origin === target.origin && !requested) {
      const signIn = page.getByRole("button", { name: /^(?:sign|log) in$/i })
        .or(page.getByRole("link", { name: /^(?:sign|log) in$/i }));
      if (await signIn.count() === 1 && await signIn.isVisible()) { await signIn.click(); requested = true; }
    }
    await pause();
  }
  throw verificationFailure ||
    new Error("The deployed session requires the selected account's normal sign-in; authenticated account and deployment were not confirmed");
}

export async function captureWindowsPreview({ directory, prId, sourceCommit, account, interactive = false }) {
  if (process.platform !== "win32") throw new Error("Persistent app sign-in requires the signed-in Windows VM");
  if (!path.isAbsolute(directory) || fs.realpathSync(directory) !== directory ||
      fs.lstatSync(directory).isSymbolicLink())
    throw new Error("The VM browser profile must not redirect");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account || ""))
    throw new Error("Select the approved sign-in account explicitly");
  const target = deployedPreview(prId, sourceCommit);
  const status = (phase, details = {}) => fs.writeFileSync(path.join(directory, "sign-in-status.json"),
    JSON.stringify({ version: 1, phase, interactive, prId, sourceCommit: target.sourceCommit,
      updatedAt: new Date().toISOString(), ...details }));
  status("opening");
  const { chromium } = createRequire(import.meta.url)("playwright-core");
  const extension = path.join(directory, "extension");
  const addresses = await resolve4(new URL(target.origin).hostname);
  if (!addresses.length) throw new Error("The deployed gateway did not resolve");
  const context = await chromium.launchPersistentContext(path.join(directory, "edge-profile"), {
    channel: "msedge", headless: !interactive, chromiumSandbox: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
      `--host-resolver-rules=MAP ${new URL(target.origin).hostname} ${addresses[0]}`],
  });
  try {
    context.setDefaultTimeout(10000);
    await context.clearCookies({ domain: new URL(target.origin).hostname, name: /^dev-auth-/ });
    const page = context.pages()[0] || await context.newPage();
    let response;
    try { response = await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 90000 }); }
    catch { throw new Error("The VM browser could not open the deployed application"); }
    if ([404, 410, 502, 503, 504].includes(response?.status()))
      throw new Error("The deployed preview is unavailable; app sign-in cannot be verified");
    const result = await waitForDeployedSignIn(context, page, target, account, {
      interactive, timeoutMs: interactive ? 900000 : 90000,
      pause: async () => {
        status("awaiting-sign-in", { pages: context.pages().map(candidate => {
          const url = new URL(candidate.url());
          return { origin: url.origin, pathname: url.pathname };
        }) });
        await new Promise(resolve => setTimeout(resolve, 1000));
      },
    });
    status("verified", { accountVerified: true, expiresOn: result.authentication.expiresOn });
    return result;
  } catch (error) {
    status("failed", { reason: /preview is unavailable/.test(error.message) ? "deployment-unavailable" :
      /watermark/.test(error.message) ? "deployment-mismatch" :
      /normal.*sign-in|MFA/.test(error.message) ? "interactive-sign-in-required" : "browser-error" });
    throw error;
  } finally { await context.close(); }
}

export async function captureWindowsApplication({ directory, account, interactive = false }) {
  if (process.platform !== "win32" || !path.isAbsolute(directory) ||
      fs.realpathSync(directory) !== directory || fs.lstatSync(directory).isSymbolicLink())
    throw new Error("The Windows VM application profile did not verify");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account || ""))
    throw new Error("Select the approved application account explicitly");
  const status = (phase, details = {}) => fs.writeFileSync(path.join(directory, "application-sign-in-status.json"),
    JSON.stringify({ phase, interactive, updatedAt: new Date().toISOString(), ...details }));
  const save = (name, value) => {
    const file = path.join(directory, name), temporary = `${file}.${randomUUID()}.tmp`;
    try { fs.writeFileSync(temporary, JSON.stringify(value)); fs.renameSync(temporary, file); }
    finally { fs.rmSync(temporary, { force: true }); }
  };
  const origin = "https://localhost:3000";
  const target = { origin, url: `${origin}/home?M365ChatFeatures=enableUnifiedHome,enableMergedHomeNav,enableTryHomeButton` };
  const { chromium } = createRequire(import.meta.url)("playwright-core");
  const extension = path.join(directory, "extension");
  let context;
  try {
    status("renewing-from-persistent-profile");
    context = await chromium.launchPersistentContext(path.join(directory, "local-edge-profile"), {
      channel: "msedge", headless: !interactive, chromiumSandbox: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    context.setDefaultTimeout(10000);
    await context.clearCookies({ domain: "localhost", name: /^dev-auth-/ });
    const page = context.pages()[0] || await context.newPage();
    let response;
    try { response = await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 45000 }); }
    catch { throw new Error("VM application-unavailable; start the MCP-built local app before testing"); }
    if (!response || response.status() >= 400) throw new Error("VM application-unavailable");
    const result = await waitForDeployedSignIn(context, page, target, account, {
      interactive, timeoutMs: interactive ? 900000 : 90000,
      capture: async () => verifiedVmApplicationState(await context.storageState({ indexedDB: true }), account),
    });
    save("local-browser-state.json", result.state);
    save("local-authentication.json", result.authentication);
    save("local-app-status.json", { phase: "account-verified", managed: true,
      updatedAt: new Date().toISOString(), ...result.authentication });
    status("verified", { accountVerified: true, expiresOn: result.authentication.expiresOn });
    return result;
  } catch (error) {
    const reason = /ProcessSingleton|profile.*use|user data directory.*use/i.test(error.message) ? "profile-busy" :
      /application-unavailable/.test(error.message) ? "application-unavailable" :
        /normal.*sign-in|MFA/.test(error.message) ? "interactive-sign-in-required" : "browser-error";
    status("failed", { reason });
    throw new Error(`VM application automatic sign-in failed (${reason})`);
  } finally { await context?.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let application = false;
  try {
    const input = JSON.parse(fs.readFileSync(0, "utf8"));
    application = input.application === true;
    process.stdout.write(JSON.stringify(await (application ? captureWindowsApplication : captureWindowsPreview)(input)));
  } catch (error) {
    const reason = /preview is unavailable/.test(error.message) ? "deployment-unavailable" :
      /normal.*sign-in|MFA/.test(error.message) ? "interactive-sign-in-required" :
      /could not open/.test(error.message) ? "application-navigation-failed" :
        /browserType|launchPersistentContext|Executable/.test(error.message) ? "edge-launch-failed" :
          /redirect/.test(error.message) ? "profile-path-invalid" :
            /queryA|ENOTFOUND|EAI_AGAIN/.test(error.message) ? "gateway-dns-failed" : "runtime-failed";
    const applicationReason = /interactive-sign-in-required/.test(error.message) ? "interactive-sign-in-required" :
      /profile-busy/.test(error.message) ? "profile-busy" :
      /application-unavailable/.test(error.message) ? "application-unavailable" : reason;
    process.stderr.write(`${application ? "VM_APPLICATION_REFRESH_FAILED" : "VM_APP_SIGN_IN_FAILED"} ${applicationReason}\n`);
    process.exitCode = 1;
  }
}
