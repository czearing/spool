import { createInterface } from "node:readline";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";

const session = "isolated-acp-session", args = process.argv.slice(2);
const saved = `${process.env.SPOOL_FIXTURE_CALL}.session`, trace = `${process.env.SPOOL_FIXTURE_CALL}.jsonl`;
let history = [], nanoAiu = 0, turns = 0, model = args[args.indexOf("--model") + 1];
const source = join(process.env.SPOOL_COPILOT_SESSION_ROOT, session);
mkdirSync(source, { recursive: true });
const event = (type, data) => appendFileSync(join(source, "events.jsonl"),
  JSON.stringify({ id: randomUUID(), type, timestamp: new Date().toISOString(), data }) + "\n");
const write = (value) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  appendFileSync(trace, JSON.stringify({ ...request, pid: process.pid, args }) + "\n");
  if (request.method === "initialize") write({ id: request.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  else if (["session/new", "session/load"].includes(request.method)) {
    if (request.method === "session/load") {
      if (!existsSync(saved)) { write({ id: request.id, error: { code: -32000, message: "Saved session unavailable" } }); continue; }
      ({ history, model, nanoAiu = 0, turns = 0 } = JSON.parse(readFileSync(saved, "utf8")));
      event("session.resume", {});
    } else {
      event("session.start", { sessionId: session });
    }
    write({ id: request.id, result: { sessionId: session, models: { currentModelId: model } } });
  }
  else if (request.method === "session/prompt") {
    const prompts = request.params.prompt.map((part) => part.text);
    const recalled = history.join("\n").match(/remember-code: ([a-z0-9-]+)/)?.[1];
    history.push(...prompts);
    nanoAiu += 1250000000;
    turns++;
    writeFileSync(saved, JSON.stringify({ history, model, nanoAiu, turns }));
    event("user.message", { content: prompts.at(-1) });
    writeFileSync(process.env.SPOOL_FIXTURE_CALL, JSON.stringify({ prompts, session, model, cwd: process.cwd(), pid: process.pid }));
    if (existsSync(`${saved}.delay`)) await setTimeout(1500);
    for (const text of ["Fixture received: ", prompts.at(-1) === "Recall the code." ? recalled ?? "MISSING" : prompts.at(-1)]) {
      write({ method: "session/update", params: { sessionId: session,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
      await setTimeout(80);
    }
    event("session.usage_checkpoint", { totalNanoAiu: nanoAiu });
    write({ id: request.id, result: { stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 20 } } });
  } else if (request.id !== undefined) write({ id: request.id, result: {} });
}
event("session.shutdown", { totalNanoAiu: nanoAiu, modelMetrics: { [model]: { usage: {
  inputTokens: turns * 100, outputTokens: turns * 20, cacheReadTokens: 0, cacheWriteTokens: 0,
} } } });
