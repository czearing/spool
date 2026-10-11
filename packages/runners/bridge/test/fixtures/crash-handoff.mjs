import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { SpoolStore } from "../../spool-store.mjs";
import { createUpdater } from "../../updater.mjs";
import { nativeControls } from "../native-controls-fixture.mjs";

const [file, stage] = process.argv.slice(2);
if (!["prepared", "queued", "accepted"].includes(stage)) throw new Error("Unknown fixture crash stage");
const { root, config, pr, workspace } = JSON.parse(fs.readFileSync(file, "utf8"));
const originalLink = fs.linkSync;
fs.linkSync = (source, target) => {
  originalLink(source, target);
  if (stage === "queued" && path.dirname(target) === path.join(root, "controls", "requests")) process.exit(71);
};
syncBuiltinESMExports();
const store = new SpoolStore(root, { processes: () => [] }), submit = store.submit.bind(store);
store.submit = async input => {
  if (stage === "prepared") process.exit(71);
  nativeControls({ after() {} }, root);
  const result = await submit(input);
  if (stage === "accepted") process.exit(71);
  return result;
};
const scan = await createUpdater({
  store, config, agent: "pr-updater", workspace, runtime: config.runtimeDirectory,
  preparationEvidence: () => "fixture-evidence",
  ado: { async listOwnPullRequests() { return [pr]; }, async getPullRequest() { return pr; },
    async listThreads() { return []; }, async listBuilds() { return []; } },
  callBohemia: async (_name, args) => ({ ready: true, repoRoot: args.repoRoot, branch: args.branch, commit: pr.sourceCommit }),
});
await scan();
throw new Error("Fixture never reached its crash boundary");
