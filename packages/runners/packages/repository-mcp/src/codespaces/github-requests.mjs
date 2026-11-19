import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execute } from "../process.mjs";

export function codespaceConnectionFailure(error) {
  const message = error?.message || String(error);
  if (error?.code === "GITHUB_RATE_LIMITED" ||
      /rate limit exceeded|secondary rate limit|HTTP[^\r\n]*\b429\b|\[Copilot ACP setup\] GITHUB_RATE_LIMITED\b/i.test(message))
    return "rate";
  if (/Permission denied|Bad credentials|Authentication failed|HTTP[^\r\n]*\b401\b|Remote review lease is no longer held|Remote revision changed|Pinned PR revision changed/i.test(message))
    return null;
  if (error?.code === "CODESPACE_UNAVAILABLE" ||
      /failed to start SSH server|SSH command channel startup timed out before any commands were sent|timed out while waiting for the codespace to start|\[Copilot ACP setup\] CODESPACE_UNAVAILABLE\b|Connection reset by peer|Connection to [^\r\n]+ closed by remote host|ssh: connect to host [^\r\n]+: (?:Connection timed out|Connection refused)|SSH command channel (?:closed|exited).*\b255\b/i.test(message))
    return "ssh";
  if (error?.code === "CODESPACE_WORKSPACE_BUSY" ||
      /\bCODESPACE_WORKSPACE_BUSY\b|Codespace workspace is busy with another operation/i.test(message)) return "busy";
  if (/You have too many codespaces running/i.test(message)) return "capacity";
  if (/Assigned Codespace is shutting down|\[Copilot ACP setup\] CODESPACE_SHUTTING_DOWN\b/i.test(message)) return "shutting-down";
  if (/error starting codespace:\s*HTTP\s+(?:400|409|422|5\d\d)\b/i.test(message)) return "start";
  return null;
}

export class CodespaceRequests {
  constructor(account, { run = execute, now = Date.now,
    directory = path.join(os.homedir(), ".cache", "repository-mcp", "github") } = {}) {
    this.run = run;
    this.now = now;
    this.directory = directory;
    this.account = createHash("sha256").update(String(account).toLowerCase()).digest("hex");
  }
  file(key) {
    return path.join(this.directory, `${this.account}-${createHash("sha256").update(key).digest("hex")}.json`);
  }
  read(key) {
    try { return JSON.parse(fs.readFileSync(this.file(key), "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; return {}; }
  }
  write(key, value) {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const file = this.file(key), temporary = `${file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
      fs.renameSync(temporary, file);
    } finally { fs.rmSync(temporary, { force: true }); }
  }
  record(operation, codespace, detail = {}) {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    fs.appendFileSync(path.join(this.directory, `${this.account}-requests.jsonl`),
      JSON.stringify({ at: new Date(this.now()).toISOString(), pid: process.pid,
        operation, codespace, ...detail }) + "\n", { mode: 0o600 });
  }
  connected(codespace) {
    this.write(`connection:${codespace}`, {});
  }
  check(codespace) {
    for (const key of ["rate", ...(codespace ? [`connection:${codespace}`] : [])]) {
      const state = this.read(key);
      if (state.until > this.now()) {
        const retryAt = new Date(state.until).toISOString();
        throw Object.assign(new Error(`${key === "rate" ? "GitHub Codespaces rate limit" : "Codespace start failure"}; ` +
          `requests deferred until ${retryAt}`), {
          code: key === "rate" ? "GITHUB_RATE_LIMITED" : "CODESPACE_UNAVAILABLE",
          reasonCode: key === "rate" ? "github_rate_limited" : "codespace_unavailable", retryAt,
        });
      }
    }
  }
  failed(error, codespace) {
    const message = error.message || String(error);
    const failure = codespaceConnectionFailure(error), limited = failure === "rate";
    const unavailable = codespace && failure;
    if (!limited && !unavailable) return;
    const key = limited ? "rate" : `connection:${codespace}`, previous = this.read(key);
    const failures = Math.min((previous.failures || 0) + 1, 10);
    const interval = limited || unavailable === "capacity" ? 60_000 : unavailable === "start" ? 300_000 : 15_000;
    let until = this.now() + Math.min(interval * 2 ** (failures - 1), 900_000);
    if (limited) {
      const retry = message.match(/^retry-after:\s*(.+)$/im)?.[1]?.trim();
      const retryAt = retry && (/^\d+$/.test(retry) ? this.now() + Number(retry) * 1000 : Date.parse(retry));
      const quota = this.read("quota");
      const primary = /API rate limit exceeded|^x-ratelimit-remaining:\s*0\s*$/im.test(message);
      const reset = Number(primary ? message.match(/^x-ratelimit-reset:\s*(\d+)/im)?.[1] ||
        quota.reset || 0 : 0) * 1000;
      until = Math.max(until, retryAt || 0, reset);
    }
    until = Math.max(until, previous.until || 0);
    this.write(key, { until, failures,
      ...(!limited && (unavailable === "ssh" || previous.requireConnection) ? { requireConnection: true } : {}) });
    error.retryAt = new Date(until).toISOString();
    error.code = limited ? "GITHUB_RATE_LIMITED" : "CODESPACE_UNAVAILABLE";
    error.reasonCode = limited ? "github_rate_limited" : "codespace_unavailable";
    this.record(limited ? "rate-limited" : "connection-failed", codespace, { retryAt: error.retryAt });
  }
  async metadataLock(codespace) {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const file = `${this.file(`metadata:${codespace}`)}.lock`;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const descriptor = fs.openSync(file, "wx", 0o600);
        fs.writeFileSync(descriptor, String(process.pid));
        fs.closeSync(descriptor);
        return () => fs.rmSync(file, { force: true });
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        try {
          const pid = Number(fs.readFileSync(file, "utf8"));
          if (Number.isSafeInteger(pid) && pid > 0) {
            try { process.kill(pid, 0); }
            catch (failure) {
              if (failure.code === "ESRCH") fs.rmSync(file, { force: true });
              else throw failure;
            }
          }
        } catch (failure) { if (failure.code !== "ENOENT") throw failure; }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    throw new Error("Codespace metadata lookup is already in progress; retry after it finishes");
  }
  async request(args, options = {}, locked = false) {
    const endpoint = args[0] === "api" ? args[1] : "";
    const codespace = endpoint?.match(/^user\/codespaces\/([^/]+)(?:\/|$)/)?.[1] ||
      (args[0] === "codespace" ? args[args.indexOf("-c") + 1] : undefined);
    const metadata = args.length === 2 && /^user\/codespaces\/[^/]+$/.test(endpoint);
    const methodIndex = args.findIndex(arg => arg === "--method" || arg === "-X");
    const readOnly = args[0] === "api" && (args.length === 2 || methodIndex >= 0 && args[methodIndex + 1] === "GET");
    this.check(readOnly ? undefined : codespace);
    if (metadata) {
      const cached = this.read(`metadata:${codespace}`);
      if (cached.expires > this.now()) {
        this.record("metadata-cache", codespace);
        return { stdout: cached.stdout, output: cached.stdout };
      }
      if (!locked) {
        const release = await this.metadataLock(codespace);
        try { return await this.request(args, options, true); }
        finally { release(); }
      }
    }
    try {
      this.record(metadata ? "metadata" : "ssh-connect", codespace);
      const result = await this.run("gh", metadata ? [...args, "--include"] : args, options);
      const rate = this.read("rate");
      if (rate.failures && rate.until <= this.now()) this.write("rate", {});
      if (codespace && endpoint === `user/codespaces/${codespace}/start`)
        this.write(`metadata:${codespace}`, {});
      if (metadata) {
        const reply = result.stdout.match(/^HTTP\/[^\r\n]+\r?\n([\s\S]*?)\r?\n\r?\n([\s\S]*)$/);
        const headers = reply?.[1] || "", stdout = reply?.[2] ?? result.stdout;
        const state = JSON.parse(stdout);
        const reset = Number(headers.match(/^x-ratelimit-reset:\s*(\d+)/im)?.[1] || 0);
        if (reset) this.write("quota", { reset });
        this.write(`metadata:${codespace}`, { stdout, expires: this.now() + 60_000 });
        if (state.state === "Available" && !this.read(`connection:${codespace}`).requireConnection)
          this.connected(codespace);
        return { ...result, stdout };
      }
      if (codespace && args[0] === "codespace" && args[1] === "ssh")
        this.connected(codespace);
      return result;
    } catch (error) {
      this.failed(error, codespace);
      throw error;
    }
  }
}
