import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { preserveApplicationSignInState, privateDirectory, privateJson } from "./application-browser.mjs";

const origin = "https://localhost:3000";
const pending = new Map();

export function verifiedVmApplicationState(state, account, now = Date.now()) {
  const cookies = state?.cookies?.filter(cookie => cookie.domain.replace(/^\./, "") === "localhost") || [];
  const read = name => {
    try { return JSON.parse(decodeURIComponent(cookies.find(cookie => cookie.name === name)?.value || "null")); }
    catch { throw new Error("The VM application authentication cookies are invalid"); }
  };
  const identity = read("dev-auth-UserInfo"), token = read("dev-auth-AccessToken");
  if (!account || identity?.userPrincipalName?.toLowerCase() !== account.toLowerCase() ||
      !identity.objectId || !identity.tenantId || !token?.accessToken ||
      !Number.isFinite(token.expirationTime) || token.expirationTime <= now + 120000)
    throw new Error("The VM application requires the selected account's normal sign-in");
  const tokens = [token, ...["dev-auth-SydneyToken", "dev-auth-CoworkerToken"]
    .filter(name => cookies.some(cookie => cookie.name === name)).map(read)];
  if (tokens.some(value => !value?.accessToken || !Number.isFinite(value.expirationTime) ||
      value.expirationTime <= now + 120000))
    throw new Error("The VM application requires the selected account's normal sign-in");
  const origins = state.origins?.filter(entry => entry.origin === origin) || [];
  if (!origins.length) throw new Error("The VM application browser authentication cache is missing");
  return { state: { cookies: preserveApplicationSignInState(cookies, identity, now), origins }, authentication: {
    version: 1, ready: true, accountVerified: true, origin,
    accountHash: createHash("sha256").update(account.toLowerCase()).digest("hex"),
    expiresOn: new Date(Math.min(...tokens.map(value => value.expirationTime))).toISOString(),
    verifiedAt: new Date(now).toISOString(),
  } };
}

function execute(command, args, input, timeout = 240000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], timeout });
    const chunks = [];
    let diagnostic = "";
    child.stdout.on("data", chunk => chunks.push(chunk));
    child.stderr.on("data", chunk => { if (diagnostic.length < 8192) diagnostic += chunk.toString("utf8"); });
    child.stdin.on("error", () => {});
    child.once("error", () => reject(new Error("VM application renewal runtime is unavailable")));
    child.once("close", code => {
      if (code !== 0) {
        const reason = /^VM_APPLICATION_REFRESH_FAILED ([a-z-]+)$/m.exec(diagnostic)?.[1] || "runtime-unavailable";
        reject(new Error(`VM application automatic renewal failed (${reason}); no stored-password fallback was attempted`));
      } else {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch { reject(new Error("VM application renewal returned an invalid response")); }
      }
    });
    child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
  });
}

export async function refreshVmApplication(configuration, { execute: run = execute } = {}) {
  const { version, directory, executable, account } = configuration || {};
  if (version !== 1 || !/^\/mnt\/[a-z]\/Users\/[^/]+\/AppData\/Local\/Spool\/browser-auth\/[a-z0-9-]+$/.test(directory || "") ||
      executable !== `${directory}/node.exe` || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account || ""))
    throw new Error("The VM application renewal configuration did not verify");
  const windowsDirectory = `${directory[5].toUpperCase()}:\\${directory.slice(7).replaceAll("/", "\\")}`;
  const captured = await run(executable,
    [`${windowsDirectory}\\packages\\repository-mcp\\src\\codespaces\\deployed-sign-in.mjs`],
    { directory: windowsDirectory, account, application: true, interactive: false }, 210000);
  return verifiedVmApplicationState(captured.state, account);
}

function owned(file) {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077))
    throw new Error("VM application authentication state is not private and owned");
  return stat;
}

function read(file) {
  if (!owned(file)) return;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function configuration(directory) {
  let value = read(path.join(directory, "vm-auth.json"));
  if (!value) {
    const enrolled = path.join(path.dirname(directory), "deployed-application", "vm-auth.json");
    if (fs.existsSync(enrolled)) privateDirectory(path.dirname(enrolled));
    value = read(enrolled);
    if (value) privateJson(path.join(directory, "vm-auth.json"), value);
  }
  return value;
}

function current(directory, config) {
  try {
    const metadata = read(path.join(directory, "authentication.json"));
    const state = read(path.join(directory, "browser-state.json"));
    if (!metadata || !state) return;
    const result = verifiedVmApplicationState(state, config.account);
    if (metadata.accountVerified === true && metadata.origin === origin &&
        Number.isFinite(Date.parse(metadata.expiresOn)) && Date.parse(metadata.expiresOn) > Date.now() + 300000 &&
        Date.parse(result.authentication.expiresOn) > Date.now() + 300000)
      return { ...result.authentication, verifiedAt: metadata.verifiedAt,
        expiresOn: new Date(Math.min(Date.parse(metadata.expiresOn),
          Date.parse(result.authentication.expiresOn))).toISOString(),
        stateDirectory: directory, storageState: path.join(directory, "browser-state.json"),
        renewal: metadata.renewal };
  } catch (error) {
    if (!(error instanceof SyntaxError) && !/normal sign-in|cookies are invalid|cache is missing/.test(error.message)) throw error;
  }
}

function save(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { privateJson(temporary, value); fs.renameSync(temporary, file); }
  finally { fs.rmSync(temporary, { force: true }); }
}

async function renew(directory) {
  privateDirectory(directory);
  const config = configuration(directory);
  if (!config) throw new Error("VM application sign-in has not been enrolled");
  const ready = current(directory, config);
  if (ready) return ready;
  const captured = await refreshVmApplication(config);
  save(path.join(directory, "browser-state.json"), captured.state);
  const authentication = { ...captured.authentication, stateDirectory: directory,
    storageState: path.join(directory, "browser-state.json"), renewal: "windows-persistent-profile" };
  save(path.join(directory, "authentication.json"), authentication);
  return authentication;
}

export async function ensureVmApplication(directory, { execute: run = execute } = {}) {
  if (!fs.existsSync(path.join(directory, "vm-auth.json")) &&
      !fs.existsSync(path.join(path.dirname(directory), "deployed-application", "vm-auth.json"))) return;
  privateDirectory(directory);
  const config = configuration(directory);
  const ready = current(directory, config);
  if (ready) return ready;
  if (!pending.has(directory)) {
    const lock = path.join(directory, "renewal.lock");
    owned(lock);
    const fd = fs.openSync(lock, "a", 0o600);
    fs.closeSync(fd);
    // The child rechecks freshness under the OS lock, including across agent processes.
    pending.set(directory, run("flock", ["--wait", "240", lock, process.execPath,
      fileURLToPath(import.meta.url), "--renew-vm-application", directory], undefined, 270000).then(() => {
      const verified = current(directory, config);
      if (!verified) throw new Error("VM application automatic renewal did not produce verified private state");
      return verified;
    }));
  }
  const renewal = pending.get(directory);
  try { return await renewal; }
  finally { if (pending.get(directory) === renewal) pending.delete(directory); }
}

export async function ensureRunningVmApplication(directory) {
  if (!fs.existsSync(path.join(directory, "vm-auth.json")) &&
      !fs.existsSync(path.join(path.dirname(directory), "deployed-application", "vm-auth.json"))) return;
  let ca;
  try { ca = fs.readFileSync("/workspaces/1JS/midgard/packages/m365-copilot-app/dist/server/lib/cert.pem"); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  const ready = await new Promise(resolve => {
    const request = https.get(`${origin}/healthz`, { ca, timeout: 1500 }, response => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve(false));
  });
  if (ready) return ensureVmApplication(directory);
}

export function vmApplicationAuthentication(config, transport, { owner, createTransport } = {}) {
  const directory = `${config.remoteTools}/application-state`;
  if (owner && (!config.sshHost || !owner.sshHost || owner.purpose !== "engineering" ||
      config.githubAccount !== owner.githubAccount))
    throw new Error("Shared VM authentication requires an approved owner on the same GitHub account");
  let pending, expires = 0;
  return {
    async ensure() {
      if (owner && expires > Date.now() + 300000) return;
      const { shellQuote } = await import("./config.mjs");
      if (!pending) {
        const shared = owner && owner.sshHost !== config.sshHost;
        const source = shared ? `import fs from "node:fs";console.log(fs.readFileSync(` +
          `${JSON.stringify(directory + "/authentication.json")},"utf8"));` : `import {ensureRunningVmApplication} from ` +
          `${JSON.stringify(config.remoteTools + "/repository-mcp/src/codespaces/application-vm.mjs")};` +
          `console.log(JSON.stringify(await ensureRunningVmApplication(${JSON.stringify(directory)})||null));`;
        pending = (async () => {
          if (shared) await shareVmApplication(owner, config, transport, createTransport);
          const { stdout } = await transport.ssh(
            `${shellQuote(config.nativeProfile.nodeExecutable)} --input-type=module -e ${shellQuote(source)}`, 300);
          const ready = JSON.parse(stdout);
          if ((!ready && shared) || ready && (ready.accountVerified !== true || ready.origin !== origin ||
              ready.stateDirectory !== directory || ready.storageState !== `${directory}/browser-state.json` ||
              !Number.isFinite(Date.parse(ready.expiresOn)) || Date.parse(ready.expiresOn) <= Date.now() + 120000))
            throw new Error("The managed VM application authentication receipt did not verify");
          if (ready) expires = Date.parse(ready.expiresOn);
        })();
      }
      const request = pending;
      try { await request; }
      finally { if (pending === request) pending = undefined; }
    },
  };
}

async function shareVmApplication(owner, target, transport, createTransport) {
  const { shellQuote } = await import("./config.mjs");
  const sourceTransport = createTransport ? createTransport(owner) :
    new (await import("./transport.mjs")).CodespaceTransport(owner);
  try {
    await sourceTransport.environment();
    await sourceTransport.verifySshRepository();
    const sourceDirectory = `${owner.remoteTools}/application-state`;
    const capture = `import fs from "node:fs";import {ensureVmApplication} from ` +
      `${JSON.stringify(owner.remoteTools + "/repository-mcp/src/codespaces/application-vm.mjs")};` +
      `const directory=${JSON.stringify(sourceDirectory)};const ready=await ensureVmApplication(directory);` +
      `if(!ready?.accountVerified)throw Error("Shared VM owner has no enrolled application sign-in");` +
      `const config=JSON.parse(fs.readFileSync(directory+"/vm-auth.json","utf8"));` +
      `console.log(JSON.stringify({state:JSON.parse(fs.readFileSync(ready.storageState,"utf8")),account:config.account}));`;
    const captured = await sourceTransport.ssh(
      `${shellQuote(owner.nativeProfile.nodeExecutable)} --input-type=module -e ${shellQuote(capture)}`, 300);
    const directory = `${target.remoteTools}/application-state`;
    const install = `import fs from "node:fs";import {verifiedVmApplicationState} from ` +
      `${JSON.stringify(target.remoteTools + "/repository-mcp/src/codespaces/application-vm.mjs")};` +
      `import {privateDirectory,privateJson} from ` +
      `${JSON.stringify(target.remoteTools + "/repository-mcp/src/codespaces/application-browser.mjs")};` +
      `const input=JSON.parse(fs.readFileSync(0,"utf8")),directory=${JSON.stringify(directory)};` +
      `const verified=verifiedVmApplicationState(input.state,input.account);privateDirectory(directory);` +
      `privateJson(directory+"/browser-state.json",verified.state);` +
      `privateJson(directory+"/authentication.json",{...verified.authentication,stateDirectory:directory,` +
      `storageState:directory+"/browser-state.json",renewal:"shared-vm-owner"});console.log("SHARED_VM_AUTH_READY");`;
    const installed = await transport.ssh(
      `${shellQuote(target.nativeProfile.nodeExecutable)} --input-type=module -e ${shellQuote(install)}`,
      60, undefined, captured.stdout);
    if (installed.stdout.trim() !== "SHARED_VM_AUTH_READY")
      throw new Error("Shared VM application authentication installation did not verify");
  } finally { await sourceTransport.dispose(); }
}

if (process.argv[2] === "--renew-vm-application") {
  try { process.stdout.write(JSON.stringify(await renew(process.argv[3]))); }
  catch (error) {
    const reason = /interactive-sign-in-required|normal sign-in/.test(error.message) ? "interactive-sign-in-required" :
      /profile-busy/.test(error.message) ? "profile-busy" :
        /application-unavailable/.test(error.message) ? "application-unavailable" :
          /private|owned/.test(error.message) ? "private-state-invalid" : "renewal-failed";
    process.stderr.write(`VM_APPLICATION_REFRESH_FAILED ${reason}\n`);
    process.exitCode = 1;
  }
}
