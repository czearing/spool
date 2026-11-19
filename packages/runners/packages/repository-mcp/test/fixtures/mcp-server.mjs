import readline from "node:readline";

const lines = readline.createInterface({ input: process.stdin });
for await (const line of lines) {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { capabilities: {} } })}\n`);
  } else if (request.method === "tools/call") {
    process.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0", method: "notifications/progress",
      params: { progressToken: request.params._meta.progressToken, progress: 1, message: "original progress" },
    })}\n`);
    process.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0", id: request.id,
      result: { content: [{ type: "text", text: "original text" }], structuredContent: request.params.arguments, isError: false },
    })}\n`);
  }
}
