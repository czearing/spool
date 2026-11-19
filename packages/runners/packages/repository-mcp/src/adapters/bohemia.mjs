import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requestMcp } from "../mcp-client.mjs";

export function configuredBohemiaTransport(environment = process.env) {
  const configuration = path.join(environment.COPILOT_HOME || path.join(os.homedir(), ".copilot"), "mcp-config.json");
  if (fs.existsSync(configuration)) {
    const registration = JSON.parse(fs.readFileSync(configuration, "utf8").replace(/^\uFEFF/, "")).mcpServers?.["bohemia-pr"];
    if (registration) {
      if (typeof registration.command !== "string" || !registration.command ||
          !Array.isArray(registration.args) || registration.args.some(value => typeof value !== "string") ||
          (registration.env !== undefined && (!registration.env || typeof registration.env !== "object" ||
            Array.isArray(registration.env) || Object.values(registration.env).some(value => typeof value !== "string"))))
        throw new Error("Existing Bohemia MCP transport configuration is invalid");
      return { command: registration.command, args: registration.args, env: registration.env };
    }
  }
  return {
    command: process.execPath,
    args: [fileURLToPath(new URL("../../../bohemia-pr-mcp/src/index.ts", import.meta.url))],
  };
}

export function bohemiaAdapter({ transport = configuredBohemiaTransport(), request = requestMcp } = {}) {
  return {
    id: "bohemia",
    async tools() {
      const result = await request(transport, "tools/list");
      return ["prepare", "build", "check", "pr"].map(operation => {
        const original = result.tools?.find(tool => tool.name === `bohemia_${operation}`);
        if (!original) throw new Error(`Bohemia did not advertise bohemia_${operation}`);
        return { operation, description: original.description, inputSchema: original.inputSchema };
      });
    },
    call(operation, input, { onProgress, progressToken } = {}) {
      return request(transport, "tools/call", {
        name: `bohemia_${operation}`, arguments: input,
        ...(progressToken !== undefined ? { _meta: { progressToken } } : {}),
      }, { onProgress });
    },
  };
}
