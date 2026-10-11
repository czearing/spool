import { verifyBundleAcceptance } from "./acceptance.mjs";

try {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== "--root" || args[2] !== "--task") {
    throw new Error("Use --root <spool-root> --task <original-task-id>");
  }
  console.log(JSON.stringify(verifyBundleAcceptance({ root: args[1], taskId: args[3], requirePublication: true })));
} catch (error) {
  console.error(`Bundle completion rejected: ${error.message}`);
  process.exitCode = 1;
}
