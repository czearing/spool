import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const sha = /^[a-f0-9]{40}$/i;
const types = new Set(["git.pullrequest.created", "git.pullrequest.updated", "git.pullrequest.merged", "git.push"]);
const digest = value => createHash("sha256").update(value).digest();

export function openEventJournal(config) {
  if (!uuid.test(config.repository) || !uuid.test(config.project) || !path.isAbsolute(config.database))
    throw new Error("Event journal requires explicit repository, project and database identities");
  fs.mkdirSync(path.dirname(config.database), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(config.database);
  fs.chmodSync(config.database, 0o600);
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE NOT NULL,
      type TEXT NOT NULL, pull_request_id INTEGER, ref_updates TEXT NOT NULL, received_at INTEGER NOT NULL
    );`);
  const identity = `${config.project.toLowerCase()}:${config.repository.toLowerCase()}`;
  db.prepare("INSERT OR IGNORE INTO metadata VALUES ('identity', ?)").run(identity);
  db.prepare("INSERT OR IGNORE INTO metadata VALUES ('journal', ?)").run(randomUUID());
  if (db.prepare("SELECT value FROM metadata WHERE key='identity'").get().value !== identity) {
    db.close();
    throw new Error("Event journal belongs to another repository");
  }
  const journal = db.prepare("SELECT value FROM metadata WHERE key='journal'").get().value;
  return {
    append(event) {
      const resource = event?.resource;
      if (!uuid.test(event?.id || "") || !types.has(event?.eventType) ||
          resource?.repository?.id?.toLowerCase() !== config.repository.toLowerCase() ||
          (resource?.repository?.project?.id || event?.resourceContainers?.project?.id)?.toLowerCase() !==
            config.project.toLowerCase())
        throw Object.assign(new Error("Event is outside the configured repository"), { status: 400 });
      const pullRequestId = event.eventType === "git.push" ? null : resource.pullRequestId;
      if (pullRequestId !== null && (!Number.isSafeInteger(pullRequestId) || pullRequestId < 1))
        throw Object.assign(new Error("Invalid event PR identity"), { status: 400 });
      const refUpdates = event.eventType === "git.push" ? resource.refUpdates : [];
      if (!Array.isArray(refUpdates) || refUpdates.some(ref =>
        typeof ref?.name !== "string" || !ref.name.startsWith("refs/") || ref.name.length > 1024 ||
        /[\0\r\n]/.test(ref.name) || !sha.test(ref.newObjectId || "")))
        throw Object.assign(new Error("Invalid pushed reference identities"), { status: 400 });
      return db.prepare(`INSERT OR IGNORE INTO events
        (event_id,type,pull_request_id,ref_updates,received_at) VALUES (?,?,?,?,?)`)
        .run(event.id, event.eventType, pullRequestId, JSON.stringify(refUpdates.map(ref => ({
          name: ref.name, newObjectId: ref.newObjectId,
        }))), Date.now()).changes > 0;
    },
    read(after = 0, limit = 200, through) {
      if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000 ||
          (through !== undefined && (!Number.isSafeInteger(through) || through < after)))
        throw new Error("Invalid event cursor");
      const head = db.prepare("SELECT COALESCE(MAX(sequence),0) AS head FROM events").get().head;
      const fence = through === undefined ? head : Math.min(through, head);
      const rows = db.prepare(`SELECT * FROM events WHERE sequence>? AND sequence<=?
        ORDER BY sequence LIMIT ?`).all(after, fence, limit);
      return { journal, repository: config.repository, project: config.project, head: fence, events: rows.map(row => ({
        sequence: row.sequence, id: row.event_id, type: row.type, pullRequestId: row.pull_request_id,
        refUpdates: JSON.parse(row.ref_updates),
      })) };
    },
    close() { db.close(); },
  };
}

export function createEventServer(config, journal) {
  if (typeof config.password !== "string" || config.password.length < 40)
    throw new Error("Event receiver requires a strong dedicated credential");
  const expected = digest(`Basic ${Buffer.from(`spool:${config.password}`).toString("base64")}`);
  const server = http.createServer({ maxHeaderSize: 8192, requestTimeout: 15000, headersTimeout: 10000 },
    async (request, response) => {
      const send = (status, value) => {
        response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify(value));
      };
      if (!timingSafeEqual(digest(request.headers.authorization || ""), expected)) {
        request.resume();
        send(401, { error: "Unauthorized" });
        return;
      }
      if (request.method === "GET" && request.url === "/health") { send(200, { ready: true }); return; }
      if (request.method !== "POST" || request.url !== "/events") { send(404, { error: "Not found" }); return; }
      if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
        request.resume();
        send(415, { error: "JSON required" });
        return;
      }
      try {
        const chunks = [];
        let bytes = 0;
        for await (const chunk of request) {
          bytes += chunk.length;
          if (bytes > 8 * 1024 * 1024) throw Object.assign(new Error("Event too large"), { status: 413 });
          chunks.push(chunk);
        }
        let event;
        try { event = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch { throw Object.assign(new Error("Invalid JSON"), { status: 400 }); }
        journal.append(event);
        send(202, { accepted: true });
      } catch (error) {
        send(error.status || 503, { error: error.status ? error.message : "Journal unavailable" });
      }
    });
  server.maxConnections = 64;
  return server;
}

async function ensureReceiver(config, configFile) {
  if (!Number.isSafeInteger(config.port) || config.port < 1024 || config.port > 65535)
    throw new Error("Invalid event receiver port");
  const headers = { authorization: `Basic ${Buffer.from(`spool:${config.password}`).toString("base64")}` };
  const check = async () => {
    const result = await fetch(`http://127.0.0.1:${config.port}/health`, {
      headers, signal: AbortSignal.timeout(2000),
    });
    if (!result.ok || (await result.json()).ready !== true) throw new Error("Unrecognized event receiver");
  };
  try { await check(); return; }
  catch (error) {
    if (!["ECONNREFUSED", "UND_ERR_CONNECT_TIMEOUT"].includes(error.cause?.code)) throw error;
  }
  const log = fs.openSync(`${config.database}.log`, "a", 0o600);
  try {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "serve", configFile], {
      detached: true, stdio: ["ignore", log, log], windowsHide: true,
    });
    child.unref();
  } finally { fs.closeSync(log); }
  for (let attempt = 0; attempt < 30; attempt++) {
    try { await check(); return; }
    catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  throw new Error("Event receiver did not become healthy");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action, configFile, after, through] = process.argv.slice(2);
  const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
  if (action === "serve") {
    const journal = openEventJournal(config);
    const server = createEventServer(config, journal);
    server.listen(config.port, "127.0.0.1");
    server.on("close", () => journal.close());
  } else if (action === "read") {
    await ensureReceiver(config, configFile);
    const journal = openEventJournal(config);
    try { console.log(JSON.stringify(journal.read(Number(after || 0), 200, through === undefined ? undefined : Number(through)))); }
    finally { journal.close(); }
  } else throw new Error("Unknown event journal operation");
}
