import { callBohemia } from "../packages/bohemia-pr-mcp/src/client.mjs";
import { callRepository } from "../packages/repository-mcp/src/client.mjs";

export function repositoryCall(config, { bohemia = callBohemia, repository = callRepository } = {}) {
  if (!config.repositoryProfile || config.repositoryProfile === "bohemia") return bohemia;
  if (config.repositoryProfile !== "1js") throw new Error("Unsupported updater repository profile");
  return async (name, input, options = {}) => {
    if (name !== "bohemia_prepare") throw new Error("The updater may only request repository preparation");
    const result = await repository("prepare", "1js", input, {
      ...options, env: { ...process.env, REPOSITORY_MCP_CONFIG: config.repositoryMcpConfig },
    });
    if (result?.isError || !result?.structuredContent?.ready)
      throw new Error("Repository MCP did not verify the 1JS updater checkout");
    return result.structuredContent;
  };
}
