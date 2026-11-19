import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { randomBytes } from "node:crypto";
import { readCodespaceConfig, shellQuote } from "../../packages/repository-mcp/src/codespaces/config.mjs";
import { CodespaceTransport, delay } from "../../packages/repository-mcp/src/codespaces/transport.mjs";
import { writeRunnerJsonAsync } from "../../packages/bohemia-agent-tooling/src/index.js";
import { requestJson } from "./ado-transport.mjs";

export async function connectCodespaceEvents({ configFile, directory, repository, project, publish = false }) {
  const profile = readCodespaceConfig(configFile);
  if (!path.isAbsolute(directory) || path.resolve(directory) === path.parse(path.resolve(directory)).root)
    throw new Error("Event receiver requires a dedicated absolute state directory");
  const remote = new CodespaceTransport(profile);
  await remote.environment();
  try {
    const details = JSON.parse((await remote.gh(["api", `user/codespaces/${profile.codespace}`])).stdout);
    if (details.repository?.full_name !== "office-fuel/1JSBridgeRepo")
      throw new Error("Event receiver requires the registered 1JS Codespace");
    const privateFile = path.join(directory, "receiver.private.json");
    let configuration;
    try { configuration = JSON.parse(await fs.readFile(privateFile, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const root = `${profile.remoteTools}-pr-events`;
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    if (!configuration) {
      if ((await fs.readdir(directory)).length) throw new Error("Event receiver requires an empty owned state directory");
      configuration = { repository, project, port: 8766, database: `${root}/events.db`,
        password: randomBytes(48).toString("base64url"), codespace: profile.codespace };
    }
    if (configuration.repository !== repository || configuration.project !== project ||
        configuration.codespace !== profile.codespace || configuration.database !== `${root}/events.db` ||
        typeof configuration.password !== "string" || configuration.password.length < 40 || configuration.port !== 8766)
      throw new Error("Event receiver configuration does not match its repository");
    const secure = configuration?.aclVersion !== 1;
    if (secure && process.platform === "win32") {
      const account = await remote.run("whoami", ["/user", "/fo", "csv", "/nh"]);
      const sid = account.stdout.match(/S-1-\d+(?:-\d+)+/)?.[0];
      if (!sid) throw new Error("Cannot identify the private event-cache owner");
      await remote.run("icacls", [directory, "/inheritance:r", "/grant:r",
        `*${sid}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F", "/T"]);
    }
    if (secure) {
      configuration.aclVersion = 1;
      await writeRunnerJsonAsync(privateFile, configuration);
      await fs.chmod(privateFile, 0o600);
    }

    const module = `${root}/pr-event-journal.mjs`, settings = `${root}/receiver.json`;
    const source = await fs.readFile(new URL("./pr-event-journal.mjs", import.meta.url), "utf8");
    const deploy = `const fs=require("node:fs");const x=JSON.parse(fs.readFileSync(0,"utf8"));` +
      `fs.mkdirSync(x.root,{recursive:true,mode:0o700});` +
      `if(fs.realpathSync(x.root)!==x.root)throw Error("Event receiver directory redirects");` +
      `fs.chmodSync(x.root,0o700);for(const [name,value] of [["pr-event-journal.mjs",x.source],` +
      `["receiver.json",JSON.stringify(x.configuration)]]){const p=x.root+"/"+name;` +
      `if(!fs.existsSync(p)||fs.readFileSync(p,"utf8")!==value){const t=p+".tmp-"+process.pid;` +
      `fs.writeFileSync(t,value,{mode:0o600,flag:"wx"});fs.renameSync(t,p);}}`;
    await remote.ssh(`${shellQuote(profile.nativeProfile.nodeExecutable)} -e ${shellQuote(deploy)}`, 60, undefined,
      JSON.stringify({ root, source, configuration }));
    const readEvents = async (after = 0, through) => {
      if (!Number.isSafeInteger(after) || after < 0 ||
          (through !== undefined && (!Number.isSafeInteger(through) || through < after)))
        throw new Error("Invalid event-feed checkpoint");
      const result = await remote.ssh(`${shellQuote(profile.nativeProfile.nodeExecutable)} ${shellQuote(module)} ` +
        `read ${shellQuote(settings)} ${after}${through === undefined ? "" : ` ${through}`}`, 60);
      return JSON.parse(result.stdout);
    };
    await readEvents();
    let publicUrl;
    if (publish) {
      let ports = JSON.parse((await remote.gh(["codespace", "ports", "-c", profile.codespace,
        "--json", "sourcePort,visibility,browseUrl"])).stdout);
      if (!ports.some(port => port.sourcePort === configuration.port)) {
        const listener = net.createServer();
        await new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
        const localPort = listener.address().port;
        await new Promise(resolve => listener.close(resolve));
        remote.start("gh", ["codespace", "ports", "forward", `${configuration.port}:${localPort}`,
          "-c", profile.codespace], "pr-event-port-registration");
        for (let attempt = 0; attempt < 20; attempt++) {
          remote.assertChildren();
          ports = JSON.parse((await remote.gh(["codespace", "ports", "-c", profile.codespace,
            "--json", "sourcePort,visibility,browseUrl"])).stdout);
          if (ports.some(port => port.sourcePort === configuration.port)) break;
          await delay(500);
        }
      }
      await remote.gh(["codespace", "ports", "visibility", `${configuration.port}:public`, "-c", profile.codespace]);
      ports = JSON.parse((await remote.gh(["codespace", "ports", "-c", profile.codespace,
        "--json", "sourcePort,visibility,browseUrl"])).stdout);
      const port = ports.find(port => port.sourcePort === configuration.port && port.visibility === "public");
      if (!port?.browseUrl) throw new Error("Authenticated event receiver was not published");
      const url = new URL(port.browseUrl);
      if (url.protocol !== "https:" || url.hostname !== `${profile.codespace}-${configuration.port}.app.github.dev` ||
          url.username || url.password) throw new Error("Unexpected event receiver origin");
      publicUrl = url.origin;
      const response = await fetch(`${publicUrl}/health`, { headers: {
        authorization: `Basic ${Buffer.from(`spool:${configuration.password}`).toString("base64")}`,
      }, redirect: "error", signal: AbortSignal.timeout(30000) });
      if (!response.ok || (await response.json()).ready !== true)
        throw new Error("Published event receiver did not pass authenticated readiness");
    }
    return { readEvents, remote, configuration, publicUrl, dispose: () => remote.dispose() };
  } catch (error) { await remote.dispose(); throw error; }
}

export async function ensureEventSubscriptions({
  organization, repository, project, directory, feed, token, request = requestJson,
}) {
  const origin = new URL(organization), receiver = new URL(feed.publicUrl);
  if (origin.protocol !== "https:" || origin.username || origin.password ||
      !(origin.hostname === "dev.azure.com" || origin.hostname.endsWith(".visualstudio.com")) ||
      receiver.protocol !== "https:" || receiver.username || receiver.password ||
      !/^[a-f0-9-]{36}$/i.test(project) || !/^[a-f0-9-]{36}$/i.test(repository) ||
      typeof feed.configuration?.password !== "string" || feed.configuration.password.length < 40)
    throw new Error("Subscriptions require approved ADO and authenticated HTTPS receiver origins");
  const base = organization.replace(/\/+$/, "");
  const endpoint = `${base}/_apis/hooks/subscriptions?api-version=7.1`;
  const scopedRequest = async (url, options, operation) => {
    try { return await request(url, options); }
    catch (error) {
      if (error.status !== 403) throw error;
      throw Object.assign(new Error(`Azure DevOps denied ${operation} for project ${project} (403). ` +
        "A project administrator must verify Service Hooks View Subscriptions and Edit Subscription permissions; " +
        "refreshing the token does not grant these permissions.", { cause: error }),
        { code: "ADO_SERVICE_HOOK_FORBIDDEN", status: 403, project });
    }
  };
  const requirePermission = async (bit, permission) => {
    const result = await scopedRequest(`${base}/_apis/permissions/cb594ebe-87dd-4fc9-ac2c-6a10a4c92046/${bit}` +
      `?tokens=${encodeURIComponent(`PublisherSecurity/${project}`)}&alwaysAllowAdministrators=true&api-version=7.1`,
      { token }, `checking ${permission}`);
    if (!Array.isArray(result?.value) || result.value.length !== 1 || typeof result.value[0] !== "boolean")
      throw new Error("Invalid effective Service Hooks permission response");
    if (!result.value[0]) throw Object.assign(new Error(`Service Hooks ${permission} permission is missing ` +
      `for project ${project}. A project administrator must grant it to the automation account before ` +
      "Library-wide review discovery can be enabled."), {
      code: "ADO_SERVICE_HOOK_PERMISSION_DENIED", status: 403, project, permission,
    });
  };
  await requirePermission(1, "View Subscriptions");
  const existing = await scopedRequest(`${endpoint}&consumerId=webHooks`, { token }, "listing Service Hooks subscriptions");
  if (!Array.isArray(existing.value)) throw new Error("Invalid existing event subscriptions");
  const subscriptions = [];
  let canCreate = false;
  for (const eventType of ["git.pullrequest.created", "git.pullrequest.updated", "git.pullrequest.merged", "git.push"]) {
    let subscription = existing.value.find(value => value.eventType === eventType &&
      value.publisherInputs?.projectId === project && value.publisherInputs?.repository === repository &&
      value.consumerInputs?.url === `${feed.publicUrl}/events`);
    if (!subscription) {
      if (!canCreate) {
        await requirePermission(2, "Edit Subscription");
        canCreate = true;
      }
      subscription = await scopedRequest(endpoint, {
        token, method: "POST", metric: "review-index.create-subscription", body: {
          publisherId: "tfs", eventType, resourceVersion: "1.0", consumerId: "webHooks", consumerActionId: "httpRequest",
          publisherInputs: { projectId: project, repository },
          consumerInputs: { url: `${feed.publicUrl}/events`, basicAuthUsername: "spool",
            basicAuthPassword: feed.configuration.password, resourceDetailsToSend: "all",
            messagesToSend: "none", detailedMessagesToSend: "none" },
        },
      }, `creating the ${eventType} Service Hooks subscription`);
    }
    if (!subscription?.id || subscription.status !== "enabled") throw new Error("PR event subscription is not enabled");
    subscriptions.push({ id: subscription.id, eventType, status: subscription.status });
    await writeRunnerJsonAsync(path.join(directory, "subscriptions.json"), {
      repository, project, publicUrl: feed.publicUrl, subscriptions,
    });
  }
  return subscriptions;
}
