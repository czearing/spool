import { writeFileSync } from "node:fs";

const args = process.argv.slice(2), session = args[args.indexOf("--session-id") + 1];
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
writeFileSync(process.env.SPOOL_FIXTURE_CALL, JSON.stringify({ prompt, session, model: args[args.indexOf("--model") + 1], cwd: process.cwd() }));
const usage = args.indexOf("--usage-output-file");
if (usage >= 0) writeFileSync(args[usage + 1], JSON.stringify({ usage: { inputTokens: 0, outputTokens: 0 } }));
console.log(JSON.stringify({ type: "result", sessionId: session }));
