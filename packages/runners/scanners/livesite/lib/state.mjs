import { readFile } from "node:fs/promises";
export { writeRunnerJsonAsync as writeJsonAtomic } from "../../../packages/bohemia-agent-tooling/src/index.js";

export async function readState(file) {
  try {
    const value = JSON.parse(await readFile(file, "utf8"));
    return {
      alerts: value.alerts || {},
      lastAssessment: value.lastAssessment || null,
      consecutiveScanFailures: value.consecutiveScanFailures || 0,
    };
  } catch (error) {
    if (error.code === "ENOENT") return { alerts: {}, lastAssessment: null, consecutiveScanFailures: 0 };
    throw error;
  }
}
