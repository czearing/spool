import fs from "node:fs";
import net from "node:net";
import { publicationContext, recordPublication } from "../../bohemia-agent-tooling/src/publications.js";
import { checkedPublication } from "../../bohemia-pr-mcp/src/pr-origin.mjs";

export async function trackPublication(result, { environment = process.env, repoRoot = process.cwd() } = {}) {
  const file = environment.SPOOL_REVIEW_AZURE_AUTH_FILE;
  if (file) {
    const config = JSON.parse(fs.readFileSync(file, "utf8"));
    if (config.bootstrap || !config.socket) return;
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(config.socket);
      let output = "";
      socket.setTimeout(5000, () => socket.destroy(new Error("Publication tracking timed out")));
      socket.on("error", reject);
      socket.on("connect", () => socket.write(JSON.stringify({
        capability: config.capability, action: "publication",
        result: Object.fromEntries(["ready", "pullRequestId", "url", "branch", "targetBranch", "commit", "targetCommit"]
          .map(key => [key, result[key]])),
      }) + "\n"));
      socket.on("data", chunk => {
        output += chunk;
        if (output.length > 4096) socket.destroy(new Error("Invalid publication tracking response"));
      });
      socket.on("end", () => {
        try {
          if (JSON.parse(output).recorded !== true) throw new Error("Publication tracking was not recorded");
          resolve();
        } catch (error) { reject(error); }
      });
    });
  }
  if (!environment.SPOOL_EXECUTION_CONTEXT && !environment.BOHEMIA_CREATOR_CONTEXT) return;
  const context = publicationContext(environment);
  let publication = { checked: false, validationOwner: "caller" }, targetCommit = result.targetCommit;
  if (context?.agent === "spelling") {
    try {
      const checked = checkedPublication({ repoRoot, headCommit: result.commit, targetRefName: result.targetBranch });
      targetCommit = checked.targetCommit;
      publication = { checked: true, baseCommit: checked.baseCommit, validationOwner: "caller" };
    } catch {
      // Missing or stale validation never blocks publication or establishes checked continuity.
    }
  }
  return recordPublication({ context, result: { ...result, targetCommit }, branch: result.branch, repoRoot, publication });
}
