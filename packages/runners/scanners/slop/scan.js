import { createTreeScanner } from "../lib/tree-scan.mjs";
import { partition } from "./exclusion.js";

export { toPosix } from "../lib/tree-scan.mjs";
export const { kindOf, scanTrees, inScope } = createTreeScanner({
  partition, skipDirectories: ["lib", "temp"],
});
