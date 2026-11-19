import { fileURLToPath } from "node:url";
import { requestMcp } from "./mcp-client.mjs";

const server = options => ({
  command: options.runtime || process.execPath,
  args: [fileURLToPath(new URL("./index.mjs", import.meta.url))],
  env: options.env,
});
function verifiedResult(result) {
  if (result?.isError) throw Object.assign(
    new Error(result.content?.map(item => item.text || "").join("\n") || "Repository operation failed"),
    result.structuredContent?.operationError || {},
  );
  return result;
}

export function callRepository(operation, repo, input, options = {}) {
  if (!["prepare", "build", "check", "pr"].includes(operation)) throw new Error("Unknown repository operation");
  return requestMcp(server(options), "tools/call", {
    name: `repo_${operation}`, arguments: { repo, input },
    _meta: { progressToken: 2 },
  }, options).then(verifiedResult);
}

export async function prepareRepositorySession(repo, input, options = {}) {
  const session = await requestMcp(server(options), "tools/call", {
    name: "repo_prepare", arguments: { repo, input }, _meta: { progressToken: 2 },
  }, { ...options, keepAlive: true });
  try { return { result: verifiedResult(session.result), close: session.close, closed: session.closed }; }
  catch (error) { await session.close(); throw error; }
}
