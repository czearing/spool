#!/usr/bin/env node
import fs from "node:fs";
import net from "node:net";
import { reviewCredentialResource } from "./azure-auth.mjs";

if (process.argv[2] !== "get-access-token" || process.argv.length > 5 ||
    process.argv[4] !== undefined && process.argv[4] !== "--json")
  throw new Error("Unsupported review credential helper request");
const scope = process.argv[3];
const resource = reviewCredentialResource(scope);
if (!resource) throw new Error("Unapproved review credential scope");
const file = process.env.SPOOL_REVIEW_AZURE_AUTH_FILE;
if (!file || !file.startsWith("/workspaces/")) throw new Error("Host Azure authentication bridge is not configured");
const diagnostic = (stage, code) => fs.appendFileSync(`${file}.status.log`,
  JSON.stringify({ at: new Date().toISOString(), stage, code }) + "\n", { mode: 0o600 });
const config = JSON.parse(fs.readFileSync(file, "utf8"));
const socket = net.createConnection(config.socket);
socket.setTimeout(30000, () => socket.destroy(new Error("Host Azure authentication bridge timed out")));
let output = "";
socket.on("connect", () => {
  socket.write(JSON.stringify({ capability: config.capability, resource }) + "\n");
});
socket.on("data", chunk => {
  output += chunk;
  if (output.length > 65536) socket.destroy(new Error("Invalid host authentication response"));
});
socket.on("error", error => {
  diagnostic("connection-failed", error.code);
  console.error("Host Azure authentication bridge is unavailable"); process.exitCode = 1;
});
socket.on("end", () => {
  try {
    const value = JSON.parse(output);
    if (value.error || !value.accessToken || value.expires_on * 1000 <= Date.now())
      throw new Error("Host credential renewal is required");
    process.stdout.write(process.argv[4] === "--json" ? `${JSON.stringify(value)}\n` : `${value.accessToken}\n`);
  } catch {
    diagnostic("invalid-response");
    console.error("Host credential renewal is required");
    process.exitCode = 1;
  }
});
