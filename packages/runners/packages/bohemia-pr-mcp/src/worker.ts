#!/usr/bin/env bun
/// One request, in a process that started moments ago.
///
/// This exists because a long-lived server holds whatever code it loaded at startup. Agent
/// sessions run for hours, so an edit to the rules reached the disk and not the agents: fifteen
/// servers were still serving the previous day's `update`, which did not run the checks, and an
/// unformatted commit reached CI through one of them. A fresh process has an empty module cache
/// for the whole import graph, which a cache-busting import cannot give: re-importing tools.ts
/// still resolves its own imports of gate.ts and validate.ts from cache.

import { text } from "node:stream/consumers";
const request = JSON.parse(await text(process.stdin));
const id = request.id ?? 0;

if (request.method === "internal/install-progress") {
  const { installProgressMessage } = await import("./install-progress.mjs");
  const { repoRoot, notBefore } = request.params?.arguments || {};
  if (typeof repoRoot !== "string" || !Number.isFinite(notBefore)) throw new Error("Invalid install progress request");
  process.stdout.write(JSON.stringify({ detail: installProgressMessage(repoRoot, notBefore) }));
} else {
  const { loadDiscordEnvironment } = await import("./discord.ts");
  const { callTool, response, tools } = await import("./tools.ts");
  loadDiscordEnvironment();
  const result =
    request.method === "tools/list"
      ? response(id, { tools })
      : await callTool(request);

  process.stdout.write(JSON.stringify(result));
}
