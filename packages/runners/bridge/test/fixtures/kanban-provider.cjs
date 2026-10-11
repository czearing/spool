const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const session = process.argv[process.argv.findIndex(arg => arg === "--session-id" || arg === "--resume") + 1];
if (!process.env.SPOOL_KANBAN_FIXTURE || !session) throw new Error("Explicit isolated fixture is required");
const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { windowsHide: true });
fs.writeFileSync(path.join(process.env.SPOOL_KANBAN_FIXTURE, `provider-${process.pid}.json`),
  JSON.stringify({ pid: process.pid, child: child.pid, session }));
console.log(JSON.stringify({ type: "assistant.message", timestamp: new Date().toISOString(),
  data: { content: "Isolated task is running until an operator moves its card." } }));
process.stdout.end();
setInterval(() => {}, 1000);
